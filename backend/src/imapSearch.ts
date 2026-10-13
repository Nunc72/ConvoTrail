// Search the user's mail servers directly (v0.0.315). The /search route
// only sees what sync stored, and sync only ever pulled ~1 year of INBOX +
// Sent; this goes to the IMAP servers themselves — every folder, no date
// limit — for the "Search mail servers" link under the search results.
//
// Ordering and paging: hits are ordered by IMAP INTERNALDATE (newest
// first) across all accounts and folders. Not by UID: a mail moved into a
// folder later gets a high UID while keeping its old internal date, so a
// bulk-filled archive folder would otherwise surface out of order. Per
// folder we fetch only the internal dates of all hits (cheap), keep the
// ones after the cursor, and fetch envelopes for the newest PAGE of
// those — any page item from that folder must be among them. The cursor
// is the sort key of the last hit shown, so "Show more" continues exactly
// there: no duplicates, no gaps. Stateless — every page re-runs SEARCH.
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { requirePool } from "./db.js";
import { decrypt } from "./crypto.js";

const PAGE = 50;
const ACCOUNT_TIMEOUT_MS = 30_000;
const MAX_FOLDERS = 40;
// Per folder, only the newest (by UID) this many hits are considered —
// keeps a one-letter-ish search from fetching dates for 100k mails.
const MAX_HITS_PER_FOLDER = 5000;
// Not worth searching: spam, deleted, unsent, and Gmail's virtual views
// (their mail is in All Mail anyway).
const SKIP_SPECIAL_USE = new Set(["\\Junk", "\\Trash", "\\Drafts", "\\Flagged", "\\Important"]);

export interface ImapSearchHit {
  accountId: string;
  accountEmail: string;
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  subject: string;
  from: { name: string | null; email: string };
  to: { name: string | null; email: string }[];
  cc: { name: string | null; email: string }[];
  date: string | null;
  seen: boolean;
  hasAttachments: boolean;
  direction: "in" | "out";
  // id of the same mail in our DB, when sync (or an earlier open) stored it
  dbId: string | null;
}

// Sort key: internal date (ms) desc, then "accountId|folder|uid" desc.
export interface SortKey { t: number; k: string }
export type Cursor = SortKey | null;
export const byKeyDesc = (a: SortKey, b: SortKey) => (b.t - a.t) || (a.k < b.k ? 1 : a.k > b.k ? -1 : 0);
export const isAfter = (x: SortKey, c: Cursor) => !c || x.t < c.t || (x.t === c.t && x.k < c.k);

function decodeCursor(s: string | undefined): Cursor {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return c && typeof c.t === "number" && typeof c.k === "string" ? { t: c.t, k: c.k } : null;
  } catch {
    return null;
  }
}
const encodeCursor = (c: SortKey) => Buffer.from(JSON.stringify({ t: c.t, k: c.k })).toString("base64url");

// One folder's part of the next page: its hits after the cursor, newest
// first, at most PAGE (enough for a page from this folder alone).
export function folderWindow(dated: SortKey[], cursor: Cursor): { window: SortKey[]; more: boolean } {
  const after = dated.filter(x => isAfter(x, cursor)).sort(byKeyDesc);
  return { window: after.slice(0, PAGE), more: after.length > PAGE };
}

// The page across all folders, plus whether anything is left after it.
export function pageOf<T extends SortKey>(candidates: T[], folderHadMore: boolean): { page: T[]; more: boolean } {
  const sorted = [...candidates].sort(byKeyDesc);
  return { page: sorted.slice(0, PAGE), more: folderHadMore || sorted.length > PAGE };
}

function addrs(list: { name?: string; address?: string }[] | undefined) {
  return (list || []).map(a => ({ name: a.name || null, email: (a.address || "").toLowerCase() }));
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
  if (node.disposition === "attachment") return true;
  const type = (node.type || "").toLowerCase();
  const named = !!(node.dispositionParameters?.filename || node.parameters?.name);
  return named && !type.startsWith("text/") && !type.startsWith("multipart/");
}

function toHit(
  acc: { id: string; email: string },
  folder: string,
  uidValidity: string,
  m: FetchMessageObject,
  inboxPath: string | undefined,
  sentPath: string | undefined,
): ImapSearchHit {
  const env = m.envelope;
  const from = addrs(env?.from)[0] || { name: null, email: "" };
  const own = acc.email.toLowerCase();
  // Same rule as buildMessageRow in sync.ts: folder pin first, then from.
  const direction: "in" | "out" =
    (sentPath && folder === sentPath) ? "out" :
    (inboxPath && folder === inboxPath) ? "in" :
    (from.email === own ? "out" : "in");
  // Displayed date: the same choice as buildMessageRow (Date header first).
  const when = env?.date || m.internalDate;
  return {
    accountId: acc.id,
    accountEmail: own,
    folder,
    uid: Number(m.uid),
    uidValidity,
    messageId: env?.messageId || null,
    subject: env?.subject || "",
    from,
    to: addrs(env?.to),
    cc: addrs(env?.cc),
    date: when ? new Date(when).toISOString() : null,
    seen: !!m.flags?.has("\\Seen"),
    hasAttachments: hasAttachment(m.bodyStructure),
    direction,
    dbId: null,
  };
}

type Candidate = ImapSearchHit & SortKey;

// v0.0.316 — the search box's scope pulldown. "all" (or anything
// unknown) keeps subject/from/to/body; a field scope searches only that
// header. Gmail gets the same through its own operators. "tag" never
// reaches here: tags only exist in Convooz.
const SCOPE_FIELD: Record<string, "from" | "to" | "cc" | "bcc" | "subject"> = {
  from: "from", to: "to", cc: "cc", bcc: "bcc", subject: "subject",
};
export function imapQuery(q: string, scope: string | undefined, gmail: boolean): Record<string, unknown> {
  const field = SCOPE_FIELD[scope || ""];
  if (gmail) {
    if (!field) return { gmraw: q };
    const term = q.replace(/[()"]/g, " ").replace(/\s+/g, " ").trim();
    return { gmraw: `${field}:(${term})` };
  }
  if (field) return { [field]: q };
  return { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] };
}

async function searchAccount(
  acc: { id: string; email: string; imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null },
  q: string,
  scope: string | undefined,
  cursor: Cursor,
): Promise<{ account: string; hits: Candidate[]; more: boolean; error?: string }> {
  if (!acc.imap_cred_enc) return { account: acc.email, hits: [], more: false, error: "no stored IMAP password" };
  const client = new ImapFlow({
    host: acc.imap_host, port: acc.imap_port, secure: true,
    auth: { user: acc.imap_user, pass: decrypt(acc.imap_cred_enc) },
    logger: false, socketTimeout: 20_000,
  });
  const hits: Candidate[] = [];
  let more = false;
  try {
    await client.connect();
    const gmail = client.capabilities.has("X-GM-EXT-1");
    const boxes = await client.list();
    const allMail = boxes.find(b => b.specialUse === "\\All");
    const inbox = boxes.find(b => b.specialUse === "\\Inbox") || boxes.find(b => b.path.toUpperCase() === "INBOX");
    const sent = boxes.find(b => b.specialUse === "\\Sent");
    // Gmail: All Mail holds every mail once (all labels). Elsewhere: every
    // selectable folder, so mail filed away by server rules is found too.
    const targets = allMail
      ? [allMail]
      : boxes.filter(b => !b.flags?.has("\\Noselect") && !SKIP_SPECIAL_USE.has(b.specialUse || "")).slice(0, MAX_FOLDERS);
    // Gmail's own search (subject, people, body — like its web search);
    // elsewhere subject/from/to/body. A scope narrows both to one field.
    const query = imapQuery(q, scope, gmail);
    // Folder pins for direction, as in sync (none for Gmail All Mail).
    const inboxPath = allMail ? undefined : inbox?.path;
    const sentPath = allMail ? undefined : sent?.path;

    for (const box of targets) {
      const lock = await client.getMailboxLock(box.path, { readOnly: true });
      try {
        const uidValidity = String((client.mailbox as { uidValidity: bigint | number }).uidValidity);
        const found = ((await client.search(query, { uid: true })) || []) as number[];
        if (found.length === 0) continue;
        const uids = [...found].sort((a, b) => b - a).slice(0, MAX_HITS_PER_FOLDER);
        const dated: SortKey[] = [];
        for await (const m of client.fetch(uids, { internalDate: true, uid: true }, { uid: true })) {
          dated.push({ t: m.internalDate ? new Date(m.internalDate).getTime() : 0, k: `${acc.id}|${box.path}|${m.uid}` });
        }
        const { window, more: folderMore } = folderWindow(dated, cursor);
        if (folderMore) more = true;
        if (window.length === 0) continue;
        const keyByUid = new Map(window.map(w => [Number(w.k.slice(w.k.lastIndexOf("|") + 1)), w]));
        for await (const m of client.fetch([...keyByUid.keys()], { envelope: true, flags: true, internalDate: true, bodyStructure: true, uid: true }, { uid: true })) {
          const sk = keyByUid.get(Number(m.uid));
          if (sk) hits.push({ ...toHit(acc, box.path, uidValidity, m, inboxPath, sentPath), t: sk.t, k: sk.k });
        }
      } finally {
        lock.release();
      }
    }
    return { account: acc.email, hits, more };
  } catch (e) {
    // Keep what we already have from this account; report the rest.
    return { account: acc.email, hits, more, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); });
  });
}

export async function imapSearchForUser(
  userId: string,
  q: string,
  cursorStr: string | undefined,
  scope?: string,
): Promise<{ hits: ImapSearchHit[]; cursor: string | null; errors: { account: string; error: string }[] }> {
  if (scope === "tag") return { hits: [], cursor: null, errors: [] }; // tags only exist in Convooz
  const pool = requirePool();
  const accounts = (await pool.query<{
    id: string; email: string; imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null;
  }>(
    `SELECT id, email, imap_host, imap_port, imap_user, imap_cred_enc
       FROM mail_accounts WHERE user_id = $1 ORDER BY email`,
    [userId],
  )).rows;
  const cursor = decodeCursor(cursorStr);

  const results = await Promise.all(accounts.map(acc =>
    withTimeout(searchAccount(acc, q, scope, cursor), ACCOUNT_TIMEOUT_MS,
      () => ({ account: acc.email, hits: [] as Candidate[], more: false, error: "mail server took too long" }))));
  const errors = results.filter(r => r.error).map(r => ({ account: r.account, error: r.error! }));
  const { page, more } = pageOf(results.flatMap(r => r.hits), results.some(r => r.more));

  // Point hits at their DB row where one exists (the FE skips the ones
  // already listed, and opening them needs no IMAP fetch).
  const groups = new Map<string, Candidate[]>();
  for (const h of page) {
    const g = `${h.accountId}|${h.folder}|${h.uidValidity}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(h);
  }
  for (const list of groups.values()) {
    const { accountId, folder, uidValidity } = list[0];
    const r = await pool.query<{ id: string; uid: number }>(
      `SELECT id, uid FROM messages
        WHERE mail_account_id = $1 AND folder = $2 AND uidvalidity = $3 AND uid = ANY($4::int[])`,
      [accountId, folder, uidValidity, list.map(h => h.uid)],
    );
    const byUid = new Map(r.rows.map(x => [Number(x.uid), x.id]));
    for (const h of list) h.dbId = byUid.get(h.uid) ?? null;
  }

  const last = page[page.length - 1];
  return {
    hits: page.map(({ t: _t, k: _k, ...hit }) => hit),
    cursor: more && last ? encodeCursor(last) : null,
    errors,
  };
}
