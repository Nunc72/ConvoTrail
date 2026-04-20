import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { supabaseAdmin } from "./supabase.js";
import { decrypt } from "./crypto.js";
import { requirePool } from "./db.js";

export interface FolderSyncStat {
  folder: string;
  fetched: number;
  inserted: number;
  skipped: number;
}
export interface SyncResult {
  ok: boolean;
  folders: FolderSyncStat[];
  contactsCreated: number;
  durationMs: number;
  error?: string;
}

const SINCE_DAYS = 90;
const PER_FOLDER_CAP = 100; // MVP safety — Fly free-tier memory + 60s HTTP timeout

// ─── Helpers ────────────────────────────────────────────────────────────────
function addrList(a: AddressObject | AddressObject[] | undefined): { email: string; name: string | null }[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: { email: string; name: string | null }[] = [];
  for (const obj of arr) {
    for (const v of obj.value) {
      if (v.address) out.push({ email: v.address.toLowerCase(), name: v.name || null });
    }
  }
  return out;
}

function snippetOf(text: string | undefined, len = 200): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t.slice(0, len);
}

function guessNameFromEmail(email: string, parsedName: string | null): string {
  if (parsedName) return parsedName;
  const local = email.split("@")[0];
  return local.split(/[._-]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// ─── Core sync ──────────────────────────────────────────────────────────────
export async function syncAccount(accountId: string): Promise<SyncResult> {
  const started = Date.now();
  if (!supabaseAdmin) return { ok: false, folders: [], contactsCreated: 0, durationMs: 0, error: "service key missing" };

  // 1) Load account + decrypt password (via pg so bytea comes back as real Buffer)
  const pool = requirePool();
  const accR = await pool.query<{
    id: string; user_id: string; email: string;
    imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null;
  }>(
    `SELECT id, user_id, email, imap_host, imap_port, imap_user, imap_cred_enc
       FROM mail_accounts WHERE id = $1`,
    [accountId],
  );
  const acc = accR.rows[0];
  if (!acc) return { ok: false, folders: [], contactsCreated: 0, durationMs: 0, error: "account not found" };
  if (!acc.imap_cred_enc) return { ok: false, folders: [], contactsCreated: 0, durationMs: 0, error: "no stored imap password" };

  const password = decrypt(acc.imap_cred_enc);
  const userId = acc.user_id;
  const userEmail = acc.email.toLowerCase();

  const client = new ImapFlow({
    host: acc.imap_host!, port: acc.imap_port!, secure: true,
    auth: { user: acc.imap_user!, pass: password },
    logger: false, socketTimeout: 20_000,
  });

  const folderStats: FolderSyncStat[] = [];
  let contactsCreated = 0;

  try {
    await client.connect();

    // 2) Discover folders via SPECIAL-USE
    const mailboxes = await client.list();
    const inbox = mailboxes.find(m => m.specialUse === "\\Inbox") || mailboxes.find(m => m.path.toUpperCase() === "INBOX");
    const sent  = mailboxes.find(m => m.specialUse === "\\Sent");
    const targets = [inbox, sent].filter(Boolean) as { path: string }[];

    const since = new Date(Date.now() - SINCE_DAYS * 86400_000);
    const allExtractedAddrs = new Map<string, string | null>(); // email → name

    for (const box of targets) {
      const stat: FolderSyncStat = { folder: box.path, fetched: 0, inserted: 0, skipped: 0 };
      const lock = await client.getMailboxLock(box.path);
      try {
        const mb = client.mailbox as { uidValidity: bigint | number };
        const uidvalidity = BigInt(mb.uidValidity);

        // UIDs since SINCE_DAYS
        const uids = (await client.search({ since }, { uid: true })) as number[];
        const recent = uids.slice(-PER_FOLDER_CAP); // newest N
        if (recent.length === 0) { folderStats.push(stat); continue; }

        // Find UIDs we already have
        const { data: existing } = await supabaseAdmin
          .from("messages")
          .select("uid")
          .eq("mail_account_id", acc.id)
          .eq("folder", box.path)
          .eq("uidvalidity", uidvalidity.toString())
          .in("uid", recent);
        const haveSet = new Set((existing ?? []).map(r => Number(r.uid)));
        const toFetch = recent.filter(u => !haveSet.has(u));
        stat.skipped = recent.length - toFetch.length;
        if (toFetch.length === 0) { folderStats.push(stat); continue; }

        // Batch-fetch via UID list
        const rows: Record<string, unknown>[] = [];
        for await (const msg of client.fetch(toFetch, { envelope: true, flags: true, source: true, internalDate: true, uid: true }, { uid: true })) {
          stat.fetched++;
          try {
            const row = await buildMessageRow(msg, acc.id, userId, box.path, uidvalidity, userEmail);
            rows.push(row);
            // collect addresses for contact extraction
            const parsed = msg.source ? await simpleParser(msg.source) : null;
            if (parsed) {
              for (const a of addrList(parsed.from)) allExtractedAddrs.set(a.email, a.name);
              for (const a of addrList(parsed.to))   allExtractedAddrs.set(a.email, a.name);
              for (const a of addrList(parsed.cc))   allExtractedAddrs.set(a.email, a.name);
            }
          } catch (e) {
            // skip unparseable
          }
        }
        if (rows.length) {
          const { error: insErr } = await supabaseAdmin.from("messages").insert(rows);
          if (insErr) throw new Error(`messages insert: ${insErr.message}`);
          stat.inserted = rows.length;
        }
      } finally {
        lock.release();
      }
      folderStats.push(stat);
    }

    // 3) Auto-extract contacts (filter out the user's own address)
    allExtractedAddrs.delete(userEmail);
    if (allExtractedAddrs.size > 0) {
      contactsCreated = await upsertContacts(userId, allExtractedAddrs);
    }

    // 4) Update last_sync_at / clear last_error
    await supabaseAdmin.from("mail_accounts")
      .update({ last_sync_at: new Date().toISOString(), last_error: null })
      .eq("id", acc.id);

    return { ok: true, folders: folderStats, contactsCreated, durationMs: Date.now() - started };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("mail_accounts").update({ last_error: msg }).eq("id", acc.id);
    return { ok: false, folders: folderStats, contactsCreated, durationMs: Date.now() - started, error: msg };
  } finally {
    try { await client.logout(); } catch {}
  }
}

async function buildMessageRow(
  msg: FetchMessageObject,
  accountId: string,
  userId: string,
  folder: string,
  uidvalidity: bigint,
  userEmail: string,
): Promise<Record<string, unknown>> {
  const parsed: ParsedMail | null = msg.source ? await simpleParser(msg.source) : null;
  const envelope = msg.envelope;
  const from = addrList(parsed?.from)[0] || (envelope?.from?.[0] ? { email: envelope.from[0].address?.toLowerCase() ?? "", name: envelope.from[0].name ?? null } : null);
  const tos = addrList(parsed?.to).map(a => ({ email: a.email, name: a.name, role: "to" }));
  const ccs = addrList(parsed?.cc).map(a => ({ email: a.email, name: a.name, role: "cc" }));
  const direction = from?.email === userEmail ? "out" : "in";

  const references = parsed?.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  const threadId = references[0] || parsed?.inReplyTo || envelope?.messageId || null;

  const flagsArr = Array.from(msg.flags || []);
  const flags = {
    seen: flagsArr.includes("\\Seen"),
    answered: flagsArr.includes("\\Answered"),
    flagged: flagsArr.includes("\\Flagged"),
    draft: flagsArr.includes("\\Draft"),
  };

  return {
    user_id: userId,
    mail_account_id: accountId,
    folder,
    uid: msg.uid,
    uidvalidity: uidvalidity.toString(),
    message_id: envelope?.messageId ?? parsed?.messageId ?? null,
    thread_id: threadId,
    from_email: from?.email ?? null,
    from_name: from?.name ?? null,
    to_emails: [...tos, ...ccs],
    subject: envelope?.subject ?? parsed?.subject ?? null,
    snippet: snippetOf(parsed?.text ?? undefined),
    body_text: parsed?.text ?? null,
    body_html: (typeof parsed?.html === "string" ? parsed.html : null),
    date: new Date(envelope?.date || msg.internalDate || parsed?.date || Date.now()).toISOString(),
    flags,
    direction,
    has_attachments: (parsed?.attachments?.length ?? 0) > 0,
  };
}

async function upsertContacts(userId: string, addrs: Map<string, string | null>): Promise<number> {
  if (!supabaseAdmin) return 0;
  const emails = [...addrs.keys()];
  // Find already-known emails
  const { data: existingEmails } = await supabaseAdmin
    .from("contact_emails")
    .select("email")
    .eq("user_id", userId)
    .in("email", emails);
  const have = new Set((existingEmails ?? []).map(r => (r.email as string).toLowerCase()));
  const toCreate = emails.filter(e => !have.has(e));
  if (toCreate.length === 0) return 0;

  // Create contacts in batch
  const contactRows = toCreate.map(email => ({
    user_id: userId,
    name: guessNameFromEmail(email, addrs.get(email) ?? null),
    primary_email: email,
  }));
  const { data: created, error: cErr } = await supabaseAdmin.from("contacts").insert(contactRows).select("id, primary_email");
  if (cErr || !created) throw new Error(`contacts insert: ${cErr?.message}`);
  const emailRows = created.map(c => ({ contact_id: c.id, user_id: userId, email: c.primary_email as string }));
  const { error: eErr } = await supabaseAdmin.from("contact_emails").insert(emailRows);
  if (eErr) throw new Error(`contact_emails insert: ${eErr.message}`);
  return created.length;
}
