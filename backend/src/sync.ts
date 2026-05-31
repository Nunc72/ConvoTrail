import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { supabaseAdmin } from "./supabase.js";
import { decrypt } from "./crypto.js";
import { requirePool } from "./db.js";
import { cleanupOrphanContacts } from "./contactCleanup.js";
import { encryptForUser, blindIndexForUser } from "./userCrypto.js";
import type pg from "pg";

export interface FolderSyncStat {
  folder: string;
  fetched: number;
  inserted: number;
  skipped: number;
  // v0.0.236: count of mails that needed flag-state reconciliation
  // between DB and IMAP this run (either direction). FE can surface a
  // banner when this is consistently high — usually means IMAP-mirror
  // is struggling.
  seenDrift?: number;
}
export interface SyncResult {
  ok: boolean;
  folders: FolderSyncStat[];
  contactsCreated: number;
  // Mails soft-deleted by the post-sync auto-purge step (oldest excess
  // above USER_TOTAL_CAP). 0 when the user is under the cap or has only
  // protected (tagged / r2m) mail in the excess.
  autoPurged?: number;
  durationMs: number;
  error?: string;
}

const SINCE_DAYS = 365;
const PER_FOLDER_CAP = 100; // MVP safety — Fly free-tier memory + 60s HTTP timeout
// Soft user-wide ceiling on stored messages. Stefan's onboarding pulled
// 16k mails from a single Gmail All Mail folder which spiked Supabase
// egress past the free-tier 5 GB monthly quota and got the project
// restricted. v0.0.216 used a per-folder cap (MAX_UIDS_PER_FOLDER=2000),
// but that still meant N folders × 2000 = a multi-folder Outlook account
// could blow through the budget. v0.0.219 makes the cap user-wide: when
// a sync runs, we compute the headroom (CAP minus the user's current
// non-trash message count) and distribute that evenly across the folders
// about to be synced. Once the user reaches the cap, sync falls through
// to the standard incremental missing-UIDs path (PER_FOLDER_CAP=100), so
// new mail keeps arriving — it just doesn't grow the historical archive
// further. For testers with mailboxes well under the cap this is a no-op.
const USER_TOTAL_CAP = 2000;
// Absolute per-folder ceiling we never exceed even when the user is at/over
// the soft cap. Bounds how large the (UID list, haveSet) operation in the
// folder loop can get, so a user with one humongous Gmail All Mail folder
// doesn't pin the sync process on a single round-trip.
const HARD_PER_FOLDER_CEILING = 5000;

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

// PostgreSQL rejects two classes of "valid JSON, invalid UTF-8" input
// when it coerces text into jsonb (or even text):
//   1. U+0000 NUL bytes anywhere in a string.
//   2. Lone UTF-16 surrogate halves — a high surrogate (0xD800-0xDBFF)
//      not followed by a low surrogate (0xDC00-0xDFFF), or vice versa.
//      Happens when an emoji or supplementary-plane char gets
//      truncated mid-pair by an upstream encoder.
// Both slip past JSON.stringify + supabase-js, then PG's jsonb parser
// bails with "invalid input syntax for type json" and the whole INSERT
// batch dies. Myriam's first Gmail sync hit both classes in succession
// — the v0.0.203 NUL strip was the first half, this surrogate strip is
// the second. Sanitize every string field before the row reaches PG.
function sanitizeStringForJsonb(s: string): string {
  // Fast path: scan once, only allocate when the string is dirty.
  let dirty = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) { dirty = true; break; }
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) { dirty = true; break; }
      i++; // valid pair, skip the low half
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      dirty = true; break;
    }
  }
  if (!dirty) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += s[i] + s[i + 1];
        i++;
      }
      // lone high surrogate → drop
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      // lone low surrogate → drop
    } else {
      out += s[i];
    }
  }
  return out;
}
function stripNulBytes<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeStringForJsonb(value) as unknown as T;
  // Pass Buffer / Uint8Array through verbatim — the per-property
  // walk below would iterate the numeric byte entries and replace
  // them as numbers, which both wastes time and corrupts encrypted
  // payloads (added in phase 1.3a). Recognise them before the
  // generic "object" branch.
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(stripNulBytes) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNulBytes(v);
    }
    return out as T;
  }
  return value;
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
// userKey (optional, 32 raw bytes) is supplied via the X-User-Key
// request header on /mail-accounts/:id/sync. When present, buildMessageRow
// fills the *_enc + *_blind columns with the user's master key in-memory
// for the duration of this sync run. When absent (locked / never set up),
// new rows go in plaintext-only — same as pre-phase-1.3 behaviour.
export async function syncAccount(accountId: string, userKey?: Buffer): Promise<SyncResult> {
  const started = Date.now();
  if (!supabaseAdmin) return { ok: false, folders: [], contactsCreated: 0, durationMs: 0, error: "service key missing" };

  // 1) Load account + decrypt password (via pg so bytea comes back as real Buffer)
  const pool = requirePool();
  const accR = await pool.query<{
    id: string; user_id: string; email: string;
    imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null;
    migrated_to_all_mail: boolean;
  }>(
    `SELECT id, user_id, email, imap_host, imap_port, imap_user, imap_cred_enc,
            migrated_to_all_mail
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
  let autoPurgedCount = 0;
  // Sum of UIDs the server has within the SINCE_DAYS window across the
  // folders we sync. Persisted to mail_accounts.sync_known_uids so the UI
  // can render "324 / 5000 synced" while the per-folder catch-up runs.
  let sumKnownUids = 0;
  // Senders of incoming mail in this sync that carried a List-Unsubscribe
  // header — i.e. newsletter mail. After the inserts land we mark their
  // contacts as is_news = true (unless the user has explicitly toggled
  // News, signalled by is_news_user_set = true).
  const newsletterSenders = new Set<string>();

  try {
    await client.connect();

    // 2) Discover folders via SPECIAL-USE.
    //
    // Strategy depends on whether the server exposes the \All special-use
    // folder (RFC 6154). On Gmail / Google Workspace this is "All Mail"
    // — a virtual folder that contains every message exactly once, no
    // matter which labels it carries (INBOX, Sent, custom labels, or
    // none of the above for archived mail). Syncing \All gives us full
    // mailbox coverage in a single pass without per-folder duplicates,
    // which is what Rik asked for: see all custom-labelled and archived
    // Gmail mail, not just what's still in INBOX.
    //
    // For providers without \All (typical IMAP4: Oxilion, FastMail, etc.)
    // we keep the previous INBOX + Sent pair — those are two distinct
    // folders with no overlap, so per-folder sync works fine.
    //
    // The \Trash folder is synced alongside whichever main strategy
    // applies, so mails the user trashed in the webmail (or anywhere
    // else) show up in Convooz's Deleted tab — and so the routes that
    // move-on-delete have a folder to push into. Rows fetched from
    // Trash carry deleted_at = now() on insert.
    const mailboxes = await client.list();
    const allMail = mailboxes.find(m => m.specialUse === "\\All");
    const trash   = mailboxes.find(m => m.specialUse === "\\Trash");
    let targets: { path: string }[];
    // v0.0.258 — capture inbox + sent paths so buildMessageRow can
    // determine direction by folder (not just by from-vs-userEmail).
    // Self-send mails (e.g. rik@tuithof.com → rik@tuithof.com) live in
    // BOTH INBOX and INBOX.Sent: the INBOX copy is the received side
    // (direction=in), the Sent copy is the sent side (direction=out).
    // Old logic looked only at the from-address and classified both as
    // "out", which made the INBOX-copy invisible in the inbox view.
    // Gmail All-Mail target combines incoming + outgoing into a single
    // folder, so for that path we leave inboxPath/sentPath undefined and
    // fall back to the from-check inside buildMessageRow.
    let inboxPath: string | undefined;
    let sentPath:  string | undefined;
    if (allMail) {
      targets = [allMail];
    } else {
      const inbox = mailboxes.find(m => m.specialUse === "\\Inbox") || mailboxes.find(m => m.path.toUpperCase() === "INBOX");
      const sent  = mailboxes.find(m => m.specialUse === "\\Sent");
      inboxPath = inbox?.path;
      sentPath  = sent?.path;
      targets = [inbox, sent].filter(Boolean) as { path: string }[];
    }
    if (trash) targets.push(trash);

    // First-run migration to All Mail: prior syncs may have written
    // INBOX / Sent rows under different folder names. We delete those
    // (FK CASCADE drops the matching r2m_state + message_tags rows)
    // and the main fetch below repopulates from All Mail. To avoid
    // losing user-armed state we snapshot r2m_state and message_tags
    // by their messages.message_id (RFC header) first, then restore
    // them after the new rows land, matching new UUID via RFC id.
    //
    // Gated on mail_accounts.migrated_to_all_mail — flipped to true at
    // the end of a successful migration so subsequent syncs SKIP this
    // block. Without that gate every sync re-deleted any non-AllMail
    // row, and a freshly-sent mail (DB-inserted with folder=Sent by
    // the send route before smtp.ts learned to look up the All Mail
    // UID) was wiped out before the next All Mail fetch could pick it
    // back up — visible to Rik as "sent mail disappears".
    let r2mSnap: Array<{ rfc_message_id: string; dismissed_at: string | null; snooze_until: string | null; snooze_count: number }> = [];
    let tagSnap: Array<{ rfc_message_id: string; tag_id: string }> = [];
    let didMigrate = false;
    if (allMail && !acc.migrated_to_all_mail) {
      const preservePaths = [allMail.path];
      if (trash) preservePaths.push(trash.path);
      const r1 = await pool.query<{ rfc_message_id: string | null; dismissed_at: string | null; snooze_until: string | null; snooze_count: number }>(
        `SELECT m.message_id AS rfc_message_id, rs.dismissed_at, rs.snooze_until, rs.snooze_count
           FROM r2m_state rs
           JOIN messages m ON m.id = rs.message_id
          WHERE m.mail_account_id = $1
            AND m.folder <> ALL($2::text[])
            AND m.message_id IS NOT NULL`,
        [acc.id, preservePaths],
      );
      r2mSnap = r1.rows.filter(r => !!r.rfc_message_id) as typeof r2mSnap;
      const r2 = await pool.query<{ rfc_message_id: string | null; tag_id: string }>(
        `SELECT m.message_id AS rfc_message_id, mt.tag_id
           FROM message_tags mt
           JOIN messages m ON m.id = mt.message_id
          WHERE m.mail_account_id = $1
            AND m.folder <> ALL($2::text[])
            AND m.message_id IS NOT NULL`,
        [acc.id, preservePaths],
      );
      tagSnap = r2.rows.filter(r => !!r.rfc_message_id) as typeof tagSnap;
      await pool.query(
        `DELETE FROM messages
          WHERE mail_account_id = $1
            AND folder <> ALL($2::text[])`,
        [acc.id, preservePaths],
      );
      didMigrate = true;
    }

    const since = new Date(Date.now() - SINCE_DAYS * 86400_000);
    const allExtractedAddrs = new Map<string, string | null>(); // email → name

    // User-wide cap (USER_TOTAL_CAP = 2000 active mails) is enforced as a
    // per-sync-run *fetch* limit, not as a slice on the IMAP UID list. The
    // earlier version sliced allUids down to folderInitialCap which broke
    // catch-up: with 941 UIDs on IMAP and a 431-cap, only the newest 431
    // were considered — once those landed in DB the loop terminated with
    // 510 older UIDs still missing forever. We now keep `uids = allUids`
    // and cap only `toFetch.length` by remaining headroom.
    const userTotalR = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM messages WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const existingMsgCount = Number(userTotalR.rows[0].cnt);
    let remainingHeadroom = Math.max(0, USER_TOTAL_CAP - existingMsgCount);

    for (const box of targets) {
      const stat: FolderSyncStat = { folder: box.path, fetched: 0, inserted: 0, skipped: 0 };
      const lock = await client.getMailboxLock(box.path);
      try {
        const mb = client.mailbox as { uidValidity: bigint | number };
        const uidvalidity = BigInt(mb.uidValidity);

        // UIDs since SINCE_DAYS, IMAP returns them ascending (oldest → newest).
        const allUids = (await client.search({ since }, { uid: true })) as number[];
        sumKnownUids += allUids.length;
        if (allUids.length === 0) { folderStats.push(stat); continue; }
        // Keep the full IMAP UID list — catch-up of older mails depends
        // on `missing` covering everything we don't have, not just a
        // newest-N slice. The user-wide cap is enforced later by capping
        // `toFetch.length` to `remainingHeadroom`. v0.0.241.
        const uids = allUids;

        // Find UIDs we already have. Earlier code only checked the newest N
        // and consequently never caught up if the very first sync hit the
        // PER_FOLDER_CAP — older messages stayed missing forever. Check
        // every UID in the window so we can detect missing ones across the
        // entire 90-day range.
        // Direct pg-pool instead of supabase-js. PostgREST silently
        // truncates the .in() filter when the rendered URL exceeds
        // its request-line limit, which is exactly what happens for
        // Gmail All Mail with 10k+ UIDs (Stefan: 18k). The truncated
        // haveSet missed UIDs we already had, the missing list then
        // included rows that did exist, and the INSERT crashed on
        // the messages_mail_account_id_folder_uid_uidvalidity_key
        // unique constraint. Fetching the whole (acct, folder,
        // uidvalidity) UID set in one go avoids the URL-length trap.
        const existingRes = await pool.query<{ uid: number }>(
          `SELECT uid
             FROM messages
            WHERE mail_account_id = $1
              AND folder = $2
              AND uidvalidity = $3`,
          [acc.id, box.path, uidvalidity.toString()],
        );
        const haveSet = new Set(existingRes.rows.map(r => Number(r.uid)));
        const missing = uids.filter(u => !haveSet.has(u));
        // Newest-first cap so the user sees recent mail immediately; older
        // missing UIDs roll in on subsequent syncs until the backlog is gone.
        // v0.0.241: also clamp by remainingHeadroom so we never push the
        // user past USER_TOTAL_CAP. Once headroom hits 0, toFetch is [] and
        // skipped reflects the residual backlog so the FE loop terminates.
        const perRoundLimit = Math.min(PER_FOLDER_CAP, remainingHeadroom);
        const toFetch = perRoundLimit > 0 ? missing.slice(-perRoundLimit) : [];
        remainingHeadroom = Math.max(0, remainingHeadroom - toFetch.length);
        // `skipped` reports the missing-mail backlog after this run — used by
        // the FE's catch-up loop (handleGetMail) to decide whether another
        // /sync is worth firing. Earlier versions computed `uids.length -
        // toFetch.length`, which also counted UIDs we already had in DB —
        // bug: the loop never terminated, so the "Syncing…" spinner stayed
        // on for minutes even when the account was fully in sync. Now only
        // mails we actually couldn't fetch this round count as skipped.
        stat.skipped = missing.length - toFetch.length;

        // Flag reconciliation runs BEFORE the early-exit-if-nothing-to-fetch
        // below, because once an account is fully caught up there are no
        // missing UIDs, but flag drift between DB and IMAP can still exist
        // (and grow). v0.0.238 moved this up from after the body-fetch:
        // v0.0.236 placed it post-fetch and consequently never ran for
        // accounts already in sync, which is exactly the case where it's
        // needed most. Two directions:
        //   DB.seen=true, IMAP no \Seen → push \Seen to IMAP (catches
        //     /flags calls whose IMAP-mirror silently failed earlier).
        //   DB.seen=false, IMAP has \Seen → update DB (catches reads
        //     done on another mail client like Mail.app on phone).
        // Best-effort; never fails the sync. Runs inside the same
        // mailbox lock as the rest of the folder processing.
        try {
          console.log(`[sync] ${box.path}: reconcile start, allUids.length=${allUids.length}`);
          const flagsByUid = new Map<number, boolean>();
          for await (const fm of client.fetch(allUids, { uid: true, flags: true }, { uid: true })) {
            flagsByUid.set(Number(fm.uid), Array.from(fm.flags || []).includes("\\Seen"));
          }
          console.log(`[sync] ${box.path}: reconcile fetched flags for ${flagsByUid.size} uids`);
          const dbRowsR = (await pool.query<{ uid: number; db_seen: boolean }>(
            `SELECT uid, COALESCE((flags->>'seen')::bool, false) AS db_seen
               FROM messages
              WHERE mail_account_id = $1 AND folder = $2 AND uidvalidity = $3
                AND deleted_at IS NULL`,
            [acc.id, box.path, uidvalidity.toString()],
          )).rows;
          const toPushSeen: number[] = [];
          const toMarkDbSeen: number[] = [];
          for (const r of dbRowsR) {
            const imapSeen = flagsByUid.get(Number(r.uid));
            if (imapSeen === undefined) continue;
            if (r.db_seen && !imapSeen) toPushSeen.push(Number(r.uid));
            else if (!r.db_seen && imapSeen) toMarkDbSeen.push(Number(r.uid));
          }
          if (toPushSeen.length > 0) {
            try {
              await client.messageFlagsAdd(toPushSeen.map(String).join(","), ["\\Seen"], { uid: true });
              console.log(`[sync] ${box.path}: pushed \\Seen to IMAP for ${toPushSeen.length} drifted mails`);
            } catch (e) {
              console.warn(`[sync] ${box.path}: pushing \\Seen failed (${toPushSeen.length} uids): ${e instanceof Error ? e.message : e}`);
            }
          }
          if (toMarkDbSeen.length > 0) {
            await pool.query(
              `UPDATE messages
                  SET flags = COALESCE(flags, '{}'::jsonb) || '{"seen": true}'::jsonb
                WHERE mail_account_id = $1 AND folder = $2 AND uidvalidity = $3
                  AND uid = ANY($4::int[])`,
              [acc.id, box.path, uidvalidity.toString(), toMarkDbSeen],
            );
            console.log(`[sync] ${box.path}: pulled \\Seen into DB for ${toMarkDbSeen.length} mails`);
          }
          stat.seenDrift = toPushSeen.length + toMarkDbSeen.length;
          console.log(`[sync] ${box.path}: reconcile done — toPush=${toPushSeen.length} toMark=${toMarkDbSeen.length} dbRows=${dbRowsR.length}`);
        } catch (e) {
          console.warn(`[sync] ${box.path}: flag reconciliation failed:`, e instanceof Error ? e.stack : e);
        }

        if (toFetch.length === 0) { folderStats.push(stat); continue; }

        // Batch-fetch via UID list
        const rows: Record<string, unknown>[] = [];
        for await (const msg of client.fetch(toFetch, { envelope: true, flags: true, source: true, internalDate: true, uid: true }, { uid: true })) {
          stat.fetched++;
          try {
            const row = await buildMessageRow(msg, acc.id, userId, box.path, uidvalidity, userEmail, userKey, inboxPath, sentPath);
            rows.push(row);
            // Collect addresses for contact extraction. Rule:
            //   • Incoming mail → only the SENDER (from_email) becomes a
            //     contact. The to/cc list on an incoming mail is just
            //     "other people who also got this", not anyone the user
            //     has a real relationship with. Earlier code extracted
            //     to/cc here too, which polluted the contact list with
            //     ~10% spurious rows (calendar-invite co-recipients,
            //     forward CCs, *@privaterelay.appleid.com aliases, etc.)
            //     that the user never sent to or received from.
            //   • Outgoing mail → the sender is the user (skipped via
            //     allExtractedAddrs.delete(userEmail) below), but every
            //     to/cc address is someone the user explicitly emailed
            //     and therefore a real contact.
            const parsed = msg.source ? await simpleParser(msg.source) : null;
            if (parsed) {
              if (row.direction === 'in') {
                for (const a of addrList(parsed.from)) allExtractedAddrs.set(a.email, a.name);
              } else {
                for (const a of addrList(parsed.to)) allExtractedAddrs.set(a.email, a.name);
                for (const a of addrList(parsed.cc)) allExtractedAddrs.set(a.email, a.name);
              }
            }
            // Newsletter detection: incoming mail with a List-Unsubscribe
            // header. The sender becomes a candidate for the News flag.
            if (
              row.direction === 'in' &&
              row.unsubscribe_url &&
              typeof row.from_email === 'string'
            ) {
              newsletterSenders.add((row.from_email as string).toLowerCase());
            }
          } catch (e) {
            // skip unparseable
          }
        }
        // Rows fetched from \Trash should land in the Deleted tab right
        // away — Convooz's deleted_at column is the FE filter signal.
        // We use now() because IMAP doesn't expose a "trashed at"
        // timestamp; the original message.date is preserved separately.
        const isTrashFolder = !!trash && box.path === trash.path;
        if (isTrashFolder) {
          const nowIso = new Date().toISOString();
          for (const row of rows) row.deleted_at = nowIso;
        }
        if (rows.length) {
          // v0.0.221: bulk INSERT via pg-pool in a single round-trip.
          // Replaces the old split-write (supabase-js .upsert + per-row
          // pg-pool UPDATE for BYTEA columns), which:
          //   1. routed everything through PostgREST, hitting a 60s timeout
          //      on larger batches with big body_html payloads (TypeError:
          //      fetch failed at ~55s in v0.0.220),
          //   2. needed a workaround for supabase-js encoding Node Buffers
          //      as {type:'Buffer',data:[…]} JSON instead of raw bytes,
          //   3. ran 1 + N round-trips per folder (one insert + one update
          //      per encrypted row).
          // Now one INSERT with ON CONFLICT DO NOTHING per folder, and the
          // _enc / _blind columns ride along atomically. Race condition
          // protection (concurrent sync runs racing to insert the same UID)
          // is unchanged — ON CONFLICT swallows the duplicate.
          await bulkInsertMessages(pool, rows);
          stat.inserted = rows.length;
        }

        // Permanent-delete detection: mails the user (or anyone) hard-
        // deleted on the server need to disappear from Convooz too,
        // otherwise the Deleted tab would accumulate ghost rows forever
        // after Gmail auto-purges Trash at 30 days. We compare the UID
        // set we just got from IMAP against the DB's UIDs for this
        // folder within the same SINCE_DAYS window. DB rows whose UID
        // is no longer in IMAP are gone for good — hard-delete them
        // (FK CASCADE handles r2m_state + message_tags). Scoped to the
        // window so older rows outside our search horizon don't get
        // wrongly dropped.
        //
        // Use the FULL IMAP UID list here (allUids, not the
        // folderInitialCap-capped `uids`). If we used the capped
        // slice, the cap would look like "missing on server" to the
        // detection pass and it would wipe every DB row outside the
        // newest N — exactly the opposite of what the cap is
        // supposed to do (cap fresh fetches, leave existing data
        // alone).
        try {
          const uidSet = new Set(allUids);
          const dbRowsInWindow = await pool.query<{ uid: number; id: string }>(
            `SELECT uid, id
               FROM messages
              WHERE mail_account_id = $1
                AND folder = $2
                AND uidvalidity = $3
                AND date >= $4`,
            [acc.id, box.path, uidvalidity.toString(), since.toISOString()],
          );
          const staleIds = dbRowsInWindow.rows
            .filter(r => !uidSet.has(Number(r.uid)))
            .map(r => r.id);
          if (staleIds.length > 0) {
            await pool.query(
              `DELETE FROM messages WHERE id = ANY($1::uuid[])`,
              [staleIds],
            );
          }
        } catch (e) {
          // Non-fatal: the next sync retries. Log so it's visible in Fly logs.
          console.warn(`[sync] permanent-delete detection failed for ${box.path}:`, e instanceof Error ? e.message : e);
        }

        // Backfill pass: messages that were synced BEFORE the
        // List-Unsubscribe code shipped have unsubscribe_url = NULL.
        // Walk up to BACKFILL_PER_FOLDER of them per sync, re-fetch
        // the IMAP source so we can parse the header, and write the
        // result (real URL or empty string). Spread over syncs so a
        // single click doesn't tie up the connection for minutes.
        const BACKFILL_PER_FOLDER = 100;
        const { data: bfRows } = await supabaseAdmin
          .from("messages")
          .select("uid")
          .eq("mail_account_id", acc.id)
          .eq("folder", box.path)
          .eq("uidvalidity", uidvalidity.toString())
          .is("unsubscribe_url", null)
          .order("date", { ascending: false })
          .limit(BACKFILL_PER_FOLDER);
        const bfUids = (bfRows ?? []).map(r => Number((r as { uid: number }).uid));
        if (bfUids.length > 0) {
          for await (const bfMsg of client.fetch(bfUids, { source: true, uid: true }, { uid: true })) {
            try {
              const parsed = bfMsg.source ? await simpleParser(bfMsg.source) : null;
              let url: string | null = null;
              let oneClick = false;
              if (parsed) {
                const h = parseUnsubscribeHeaders(parsed.headers);
                url = h.url;
                oneClick = h.oneClick;
                if (!url) {
                  // Body-html fallback (same logic as the live ingestion).
                  const fromBody = findBodyUnsubscribeLink(parsed.html);
                  if (fromBody) { url = fromBody; oneClick = false; }
                }
              }
              await supabaseAdmin
                .from("messages")
                .update({
                  unsubscribe_url: url ?? '',
                  unsubscribe_one_click: oneClick,
                })
                .eq("mail_account_id", acc.id)
                .eq("folder", box.path)
                .eq("uidvalidity", uidvalidity.toString())
                .eq("uid", bfMsg.uid);
              // Feed the auto-news pass that runs after the folder
              // loop, so back-filled newsletters tag their contact too.
              if (url && parsed?.from) {
                const fromAddrs = addrList(parsed.from);
                if (fromAddrs[0]?.email) newsletterSenders.add(fromAddrs[0].email);
              }
            } catch {/* skip unparseable, try next */}
          }
        }
      } finally {
        lock.release();
      }
      folderStats.push(stat);
    }

    // Restore r2m_state + message_tags that we snapshotted before the
    // All Mail migration delete above. Match by RFC message_id → new
    // message UUID. Snoozes / dismissed-at / snooze_count survive.
    // Tag links survive. A message that hasn't been re-fetched yet
    // (older than PER_FOLDER_CAP, will land in a future sync) is just
    // silently skipped this round; the snapshot, however, lives only
    // inside this run, so its state is then permanently lost. That's
    // a known trade-off — the alternative (a persistent pending table)
    // adds DB schema we don't need for a one-time migration affecting
    // a handful of rows on Rik's Gmail accounts.
    if (allMail && (r2mSnap.length > 0 || tagSnap.length > 0)) {
      for (const r of r2mSnap) {
        const m = await pool.query<{ id: string }>(
          `SELECT id FROM messages
            WHERE mail_account_id = $1 AND message_id = $2
            LIMIT 1`,
          [acc.id, r.rfc_message_id],
        );
        if (m.rows[0]) {
          await pool.query(
            `INSERT INTO r2m_state (message_id, dismissed_at, snooze_until, snooze_count)
                  VALUES ($1, $2, $3, $4)
             ON CONFLICT (message_id) DO UPDATE SET
               dismissed_at = EXCLUDED.dismissed_at,
               snooze_until = EXCLUDED.snooze_until,
               snooze_count = EXCLUDED.snooze_count`,
            [m.rows[0].id, r.dismissed_at, r.snooze_until, r.snooze_count],
          );
        }
      }
      for (const t of tagSnap) {
        const m = await pool.query<{ id: string }>(
          `SELECT id FROM messages
            WHERE mail_account_id = $1 AND message_id = $2
            LIMIT 1`,
          [acc.id, t.rfc_message_id],
        );
        if (m.rows[0]) {
          await pool.query(
            `INSERT INTO message_tags (message_id, tag_id)
                  VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [m.rows[0].id, t.tag_id],
          );
        }
      }
    }

    // 3) Auto-extract contacts. v0.0.258: the user's OWN address is no
    // longer filtered out — self-send mails (rik@me → rik@me) need a
    // self-contact so the INBOX-copy (direction=in) has someone to
    // attach to in the FE shape. Without a self-contact the shape's
    // contactId lookup returns null and the mail is silently dropped.
    if (allExtractedAddrs.size > 0) {
      contactsCreated = await upsertContacts(userId, allExtractedAddrs, userKey);
    }

    // 3a) Vangnet voor "wees" mails — distinct from_emails in DB die
    // (om welke reden dan ook) géén contact_emails row hebben. Kon
    // gebeuren als een eerdere sync een race had, een insert faalde,
    // of de upsert-pad simpelweg overgeslagen werd doordat de UID al
    // bekend was. Elke sync-run vult eventuele gaten op.
    try {
      const orphans = await pool.query<{ from_email: string }>(
        `SELECT DISTINCT m.from_email
           FROM messages m
          WHERE m.user_id = $1
            AND m.from_email IS NOT NULL AND m.from_email <> ''
            AND NOT EXISTS (
              SELECT 1 FROM contact_emails ce
               WHERE ce.user_id = m.user_id
                 AND LOWER(ce.email) = LOWER(m.from_email)
            )`,
        [userId],
      );
      if (orphans.rows.length > 0) {
        const orphanMap = new Map<string, string | null>();
        for (const r of orphans.rows) orphanMap.set(r.from_email, null);
        // v0.0.258 — userEmail no longer excluded; orphan-recovery now
        // backfills a self-contact for accounts that have existing
        // self-send rows in DB without a matching contact_emails entry.
        if (orphanMap.size > 0) {
          contactsCreated += await upsertContacts(userId, orphanMap, userKey);
        }
      }
    } catch {
      // Non-fatal — main sync already succeeded; orphan cleanup
      // retries on the next sync run.
    }

    // 3.5) Auto-tag newsletter contacts. For each sender that had a
    // List-Unsubscribe header in this sync, flip is_news = true — but
    // ONLY when the user hasn't already toggled News themselves
    // (is_news_user_set = false). Look up contact_id via contact_emails.
    if (newsletterSenders.size > 0) {
      const senderArr = [...newsletterSenders];
      const { data: emailRows } = await supabaseAdmin
        .from("contact_emails")
        .select("contact_id, email")
        .eq("user_id", userId)
        .in("email", senderArr);
      const contactIds = [...new Set((emailRows ?? []).map(r => r.contact_id as string))];
      if (contactIds.length > 0) {
        await supabaseAdmin
          .from("contacts")
          .update({ is_news: true })
          .in("id", contactIds)
          .eq("is_news_user_set", false);
      }
    }

    // (Noreply auto-tag is applied at contact-creation time inside
    // upsertContacts so only new contacts get tagged. Existing
    // contacts are intentionally left alone — Rik prefers manual
    // control there. The FE tab logic (getTab in index.html) gives
    // News priority over Noreply when both flags happen to be set on
    // the same contact.)

    // 3.7) Orphan-contact sweep. Permanent-delete detection above (and
    // any account-level cleanup elsewhere) can leave behind contacts
    // whose only mails just disappeared from the DB. Drop them so the
    // contact list reflects what's actually fetchable. Best-effort —
    // a failure here doesn't roll back the sync.
    try {
      const removed = await cleanupOrphanContacts(userId);
      if (removed > 0) {
        console.log(`[sync] removed ${removed} orphan contacts for user ${userId}`);
      }
    } catch (e) {
      console.warn(`[sync] orphan-contact cleanup failed:`, e instanceof Error ? e.message : e);
    }

    // 4) Update last_sync_at, sync_known_uids, clear last_error.
    //    Also flip migrated_to_all_mail = true if this run completed
    //    the one-time All-Mail consolidation, so future syncs skip the
    //    delete pass entirely.
    const accountUpdate: Record<string, unknown> = {
      last_sync_at: new Date().toISOString(),
      last_error: null,
      sync_known_uids: sumKnownUids,
    };
    if (didMigrate) accountUpdate.migrated_to_all_mail = true;
    await supabaseAdmin.from("mail_accounts")
      .update(accountUpdate)
      .eq("id", acc.id);

    // 5) Auto-purge oldest mails above USER_TOTAL_CAP. Soft-delete with
    //    flags.auto_purged = true so /bootstrap can hide them from the UI
    //    (including Archive) but sync's haveSet still includes their UIDs
    //    and won't re-fetch them on the next run. Protected: messages with
    //    any message_tags row, or with an armed (dismissed_at IS NULL)
    //    r2m_state row — those are user-curated and stay. Best-effort: a
    //    failure here never kills the overall sync.
    try {
      const activeR = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM messages
          WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const activeCount = Number(activeR.rows[0].cnt);
      if (activeCount > USER_TOTAL_CAP) {
        const excess = activeCount - USER_TOTAL_CAP;
        const purgeR = await pool.query<{ id: string }>(
          `WITH candidates AS (
             SELECT m.id
               FROM messages m
              WHERE m.user_id = $1
                AND m.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM message_tags mt WHERE mt.message_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM r2m_state rs WHERE rs.message_id = m.id AND rs.dismissed_at IS NULL)
              ORDER BY m.date ASC NULLS FIRST
              LIMIT $2
           )
           UPDATE messages
              SET deleted_at = NOW(),
                  flags = COALESCE(flags, '{}'::jsonb) || '{"auto_purged": true}'::jsonb
            WHERE id IN (SELECT id FROM candidates)
           RETURNING id`,
          [userId, excess],
        );
        if (purgeR.rowCount && purgeR.rowCount > 0) {
          // Surfaced as part of SyncResult so the FE can show "X mails archived"
          // if/when we add a polish ribbon for it. For now, just available
          // through the API contract.
          autoPurgedCount = purgeR.rowCount;
        }
      }
    } catch {
      // Auto-purge is best-effort; never fail the sync.
    }

    return { ok: true, folders: folderStats, contactsCreated, autoPurged: autoPurgedCount, durationMs: Date.now() - started };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("mail_accounts").update({ last_error: msg }).eq("id", acc.id);
    return { ok: false, folders: folderStats, contactsCreated, durationMs: Date.now() - started, error: msg };
  } finally {
    try { await client.logout(); } catch {}
  }
}

// Columns the bulk-INSERT writes, in fixed order. Must line up with the
// keys returned by buildMessageRow (with deleted_at as an optional extra).
const MESSAGE_INSERT_COLS = [
  'user_id', 'mail_account_id', 'folder', 'uid', 'uidvalidity',
  'message_id', 'thread_id', 'from_email', 'from_name', 'to_emails',
  'subject', 'snippet', 'body_text', 'body_html',
  'subject_enc', 'snippet_enc', 'body_text_enc', 'body_html_enc',
  'from_email_enc', 'from_name_enc', 'to_emails_enc',
  'from_email_blind', 'to_emails_blind',
  'date', 'flags', 'direction', 'has_attachments',
  'unsubscribe_url', 'unsubscribe_one_click', 'deleted_at',
] as const;

// Per-column placeholder casts. pg-node can usually infer types from the
// value, but some columns need an explicit cast: jsonb because we pass a
// stringified value, bytea[] because pg-node doesn't auto-cast arrays of
// Buffers, bigint because uidvalidity arrives as a string.
const MESSAGE_INSERT_CASTS: Record<string, string> = {
  to_emails: '::jsonb',
  flags: '::jsonb',
  to_emails_blind: '::bytea[]',
  uidvalidity: '::bigint',
};

// Max rows we INSERT in a single statement. Hit by Supabase's Postgres
// statement_timeout: in v0.0.221 a 100-row INSERT (with newsletter-sized
// body_html through TOAST compression + jsonb validation) blew through
// at ~41s. v0.0.222 dropped to 25 — still timing out at ~44s, which
// means a single newsletter with multi-MB inline-image body_html
// dominates the batch. v0.0.223 drops further to 10 AND raises the
// session statement_timeout to 5 min via SET LOCAL inside a tx, so
// even an oversized newsletter can't kill the chunk.
const INSERT_CHUNK_SIZE = 10;

// Bulk-insert one folder's worth of message rows, chunked to stay under
// the PG statement_timeout. ON CONFLICT DO NOTHING handles the
// (mail_account_id, folder, uid, uidvalidity) unique constraint so two
// concurrent sync runs can't blow up the batch on a race.
async function bulkInsertMessages(pool: pg.Pool, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    await bulkInsertMessagesChunk(pool, chunk);
  }
}

async function bulkInsertMessagesChunk(pool: pg.Pool, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const groups: string[] = [];
  const values: unknown[] = [];
  let n = 1;
  for (const row of rows) {
    const placeholders = MESSAGE_INSERT_COLS.map(col => {
      const cast = MESSAGE_INSERT_CASTS[col] ?? '';
      return `$${n++}${cast}`;
    });
    groups.push(`(${placeholders.join(', ')})`);
    for (const col of MESSAGE_INSERT_COLS) {
      const v = row[col];
      if (v === undefined || v === null) {
        values.push(null);
      } else if (col === 'to_emails' || col === 'flags') {
        // jsonb columns: stringify so pg sends the JSON text and the
        // ::jsonb cast parses it server-side.
        values.push(JSON.stringify(v));
      } else {
        values.push(v);
      }
    }
  }
  const sql =
    `INSERT INTO messages (${MESSAGE_INSERT_COLS.join(', ')})
     VALUES ${groups.join(', ')}
     ON CONFLICT (mail_account_id, folder, uid, uidvalidity) DO NOTHING`;
  // Borrow a dedicated client so SET LOCAL applies to this transaction's
  // INSERT and nothing else. Supabase's pooler default statement_timeout
  // is too tight for big newsletter HTML — SET LOCAL bumps it to 5 min
  // for just this statement, then BEGIN/COMMIT scopes it down again so
  // we don't leak the bump back into the pool.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function buildMessageRow(
  msg: FetchMessageObject,
  accountId: string,
  userId: string,
  folder: string,
  uidvalidity: bigint,
  userEmail: string,
  userKey?: Buffer,
  inboxPath?: string,
  sentPath?: string,
): Promise<Record<string, unknown>> {
  const parsed: ParsedMail | null = msg.source ? await simpleParser(msg.source) : null;
  const envelope = msg.envelope;
  const from = addrList(parsed?.from)[0] || (envelope?.from?.[0] ? { email: envelope.from[0].address?.toLowerCase() ?? "", name: envelope.from[0].name ?? null } : null);
  const tos = addrList(parsed?.to).map(a => ({ email: a.email, name: a.name, role: "to" }));
  const ccs = addrList(parsed?.cc).map(a => ({ email: a.email, name: a.name, role: "cc" }));
  // v0.0.258 — direction by folder when we can identify it (Inbox vs
  // Sent on conventional IMAP), with the from-vs-userEmail check as the
  // fallback for Gmail All-Mail (no inbox/sent distinction) and the
  // Trash folder (could be either direction depending on what got moved
  // there). Self-send (from = userEmail) used to be classified as "out"
  // by the from-check alone — for the INBOX copy that's wrong; the
  // user *received* that mail, so the folder pin is authoritative.
  const direction: "in" | "out" =
    (sentPath  && folder === sentPath)  ? "out" :
    (inboxPath && folder === inboxPath) ? "in"  :
    (from?.email === userEmail ? "out" : "in");

  const references = parsed?.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  const threadId = references[0] || parsed?.inReplyTo || envelope?.messageId || null;

  const flagsArr = Array.from(msg.flags || []);
  const flags = {
    seen: flagsArr.includes("\\Seen"),
    answered: flagsArr.includes("\\Answered"),
    flagged: flagsArr.includes("\\Flagged"),
    draft: flagsArr.includes("\\Draft"),
  };

  // Newsletter detection has two stages:
  //   1. List-Unsubscribe header (RFC 2369), optionally with
  //      List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058)
  //      for the no-browser-roundtrip flow.
  //   2. As a fallback for senders that don't ship the header (still
  //      common in real life, e.g. Technische Unie), scan body_html
  //      for an "unsubscribe"-style link. Apple Mail does the same.
  let { url: unsubscribeUrl, oneClick: unsubscribeOneClick } =
    parseUnsubscribeHeaders(parsed?.headers);
  if (!unsubscribeUrl) {
    const fromBody = findBodyUnsubscribeLink(parsed?.html);
    if (fromBody) {
      unsubscribeUrl = fromBody;
      unsubscribeOneClick = false; // body-link is never one-click
    }
  }

  // Phase 1.3a: when a user key is present (the FE sent X-User-Key on
  // this sync request because the user has unlocked encryption), fill
  // in the *_enc + *_blind columns alongside the existing plaintext
  // columns. Dual-write for now so we can roll out the read-path
  // (phase 1.4) at our own pace without losing access to mail. The
  // plaintext columns will be dropped once the read-path migration
  // settles.
  const subject = envelope?.subject ?? parsed?.subject ?? null;
  const snippet = snippetOf(parsed?.text ?? undefined);
  const bodyText = parsed?.text ?? null;
  const bodyHtml = typeof parsed?.html === "string" ? parsed.html : null;
  const fromEmail = from?.email ?? null;
  const fromName  = from?.name  ?? null;
  const toEmails: Array<{ email: string; name: string | null; role: string }> = [...tos, ...ccs];
  let subject_enc:        Buffer | null = null;
  let snippet_enc:        Buffer | null = null;
  let body_text_enc:      Buffer | null = null;
  let body_html_enc:      Buffer | null = null;
  let from_email_enc:     Buffer | null = null;
  let from_name_enc:      Buffer | null = null;
  let to_emails_enc:      Buffer | null = null;
  let from_email_blind:   Buffer | null = null;
  let to_emails_blind:    Buffer[] | null = null;
  if (userKey) {
    [subject_enc, snippet_enc, body_text_enc, body_html_enc, from_email_enc, from_name_enc, to_emails_enc, from_email_blind] = await Promise.all([
      encryptForUser(subject,                                userKey),
      encryptForUser(snippet,                                userKey),
      encryptForUser(bodyText,                               userKey),
      encryptForUser(bodyHtml,                               userKey),
      encryptForUser(fromEmail,                              userKey),
      encryptForUser(fromName,                               userKey),
      encryptForUser(toEmails.length ? JSON.stringify(toEmails) : null, userKey),
      blindIndexForUser(fromEmail,                           userKey),
    ]);
    // Per-recipient blind indices so the FE can match a contact_email
    // blind against any to_emails entry without seeing the plaintext.
    const blinds: Buffer[] = [];
    for (const r of toEmails) {
      const b = await blindIndexForUser(r.email, userKey);
      if (b) blinds.push(b);
    }
    to_emails_blind = blinds.length ? blinds : null;
  }

  // Runs everything through stripNulBytes before returning so a sloppy
  // sender's NUL-laden header / body can't take out the whole INSERT
  // batch with a "invalid input syntax for type json" error. Buffer
  // values (the *_enc + *_blind columns above) pass through verbatim
  // — see stripNulBytes for that early-out.
  return stripNulBytes({
    user_id: userId,
    mail_account_id: accountId,
    folder,
    uid: msg.uid,
    uidvalidity: uidvalidity.toString(),
    message_id: envelope?.messageId ?? parsed?.messageId ?? null,
    thread_id: threadId,
    from_email: fromEmail,
    from_name:  fromName,
    to_emails:  toEmails,
    subject,
    snippet,
    body_text:  bodyText,
    body_html:  bodyHtml,
    // Encrypted twins (NULL when no user key was supplied).
    subject_enc,
    snippet_enc,
    body_text_enc,
    body_html_enc,
    from_email_enc,
    from_name_enc,
    to_emails_enc,
    from_email_blind,
    to_emails_blind,
    date: new Date(envelope?.date || msg.internalDate || parsed?.date || Date.now()).toISOString(),
    flags,
    direction,
    has_attachments: (parsed?.attachments?.length ?? 0) > 0,
    // Empty string means "we checked, no List-Unsubscribe header". Stays
    // distinct from NULL ("not checked yet") so the backfill pass below
    // can target only the unchecked rows.
    unsubscribe_url: unsubscribeUrl ?? '',
    unsubscribe_one_click: unsubscribeOneClick,
  });
}

// Parse the List-Unsubscribe and List-Unsubscribe-Post headers from a
// mailparser ParsedMail.headers map. Returns the http(s) URL when
// present (preferred over mailto: since the one-click flow is HTTP),
// otherwise falls back to mailto:, otherwise null.
// Fallback for senders that don't ship a List-Unsubscribe header but
// embed an "unsubscribe" link in the HTML body — common with commercial
// newsletters. Apple Mail does the same fallback. We accept a link
// whose visible text or URL path mentions an opt-out word in Dutch or
// English (uitschrijven / afmelden / unsubscribe / unsub / opt-out).
// Returns the first matching http(s) URL, or null.
function findBodyUnsubscribeLink(html: string | boolean | null | undefined): string | null {
  if (typeof html !== "string" || !html) return null;
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const OPT_OUT = /unsubscribe|unsub\b|opt[-_]?out|afmelden|uitschrijven/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (OPT_OUT.test(innerText) || OPT_OUT.test(url)) return url;
  }
  return null;
}

function parseUnsubscribeHeaders(headers: Map<string, unknown> | undefined): { url: string | null; oneClick: boolean } {
  if (!headers) return { url: null, oneClick: false };
  // mailparser lowercases header names.
  const raw = headers.get("list-unsubscribe");
  if (!raw || typeof raw !== "string") return { url: null, oneClick: false };
  const post = headers.get("list-unsubscribe-post");
  const oneClick = typeof post === "string" && /one-click/i.test(post);
  // RFC 2369 spec is comma-separated <url> entries, but real-world
  // senders sometimes ship bare URLs without angle brackets, or use
  // surrounding quotes. Try angle-bracket entries first; if there are
  // none, comma-split and accept any http(s)/mailto bare URL.
  const entries: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) entries.push(m[1].trim());
  if (entries.length === 0) {
    for (const part of raw.split(',')) {
      const cleaned = part.trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
      if (/^(https?:\/\/|mailto:)/i.test(cleaned)) entries.push(cleaned);
    }
  }
  if (entries.length === 0) return { url: null, oneClick: false };
  const http = entries.find(e => /^https?:\/\//i.test(e));
  if (http) return { url: http, oneClick };
  const mail = entries.find(e => /^mailto:/i.test(e));
  // mailto can't be one-click — RFC 8058 requires HTTP.
  if (mail) return { url: mail, oneClick: false };
  return { url: null, oneClick: false };
}

async function upsertContacts(
  userId: string,
  addrs: Map<string, string | null>,
  userKey?: Buffer,
): Promise<number> {
  if (!supabaseAdmin) return 0;
  const pool = requirePool();
  const emails = [...addrs.keys()];
  if (emails.length === 0) return 0;

  // v0.0.268 — restore the plaintext-existing-check path for instances
  // that haven't set up encryption (prod was deployed v0.0.258 without
  // ever running the Phase 1.5 setup, so userKey never flows through
  // sync). The earlier hard `if (!userKey) return 0` silently dropped
  // every new sender on those instances — including veraramer's
  // "Fwd: een goed jaar!" that lit this up. We now branch:
  //   • userKey present (staging): blind-only match, same as v0.0.255.
  //   • userKey absent  (prod, pre-encryption): plaintext (LOWER) match
  //     against the same column. _enc + blind columns stay NULL for
  //     these rows; the existing backfill route picks them up the
  //     moment the user sets up encryption.
  let toCreate: string[];
  if (userKey) {
    const blindByEmail = new Map<string, Buffer>();
    for (const email of emails) {
      const b = await blindIndexForUser(email, userKey);
      if (b) blindByEmail.set(email, b);
    }
    const blinds = [...blindByEmail.values()];
    if (blinds.length === 0) return 0;
    const existingR = await pool.query<{ email_blind: Buffer | null }>(
      `SELECT email_blind FROM contact_emails
        WHERE user_id = $1 AND email_blind = ANY($2::bytea[])`,
      [userId, blinds],
    );
    const haveBlinds = new Set(
      existingR.rows.map(r => r.email_blind?.toString("base64")).filter(Boolean) as string[],
    );
    toCreate = emails.filter(e => {
      const b = blindByEmail.get(e);
      return b && !haveBlinds.has(b.toString("base64"));
    });
  } else {
    const lowered = emails.map(e => e.toLowerCase());
    const existingR = await pool.query<{ email: string }>(
      `SELECT email FROM contact_emails
        WHERE user_id = $1 AND LOWER(email) = ANY($2::text[])`,
      [userId, lowered],
    );
    const haveEmails = new Set(existingR.rows.map(r => r.email.toLowerCase()));
    toCreate = emails.filter(e => !haveEmails.has(e.toLowerCase()));
  }
  if (toCreate.length === 0) return 0;

  // Phase 1.5b/c — when the user is unlocked, fill the encrypted twins
  // for name/org and the blind index + ciphertext for email. Plaintext
  // stays alongside (dual-write). Insert goes through pg-pool because
  // supabase-js mangles Node Buffers as JSON.
  const NOREPLY_LOCAL_RE = /(noreply|no-reply)/i;
  let created = 0;
  for (const email of toCreate) {
    const localPart = email.split("@")[0] ?? "";
    const name = guessNameFromEmail(email, addrs.get(email) ?? null);
    const isNoReply = NOREPLY_LOCAL_RE.test(localPart);
    let nameEnc: Buffer | null = null;
    let emailBlind: Buffer | null = null;
    let emailEnc: Buffer | null = null;
    if (userKey) {
      [nameEnc, emailBlind, emailEnc] = await Promise.all([
        encryptForUser(name,    userKey),
        blindIndexForUser(email, userKey),
        encryptForUser(email,   userKey),
      ]);
    }
    try {
      const cRes = await pool.query<{ id: string }>(
        `INSERT INTO contacts (user_id, name, primary_email, is_no_reply, name_enc)
              VALUES ($1, $2, $3, $4, $5)
            RETURNING id`,
        [userId, name, email, isNoReply, nameEnc],
      );
      const cid = cRes.rows[0]?.id;
      if (!cid) continue;
      await pool.query(
        `INSERT INTO contact_emails (contact_id, user_id, email, email_blind, email_enc)
              VALUES ($1, $2, $3, $4, $5)`,
        [cid, userId, email, emailBlind, emailEnc],
      );
      created++;
    } catch (e) {
      console.warn(`[sync] upsertContacts: failed for ${email}:`, e instanceof Error ? e.message : e);
    }
  }
  return created;
}
