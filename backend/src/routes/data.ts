import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { maybeCleanupAuditLog } from "../audit.js";
import { sendTransientOr500 } from "../errors.js";
import { requirePool } from "../db.js";

// pg returns timestamptz columns as JS Date objects, but supabase-js (which
// previously powered /bootstrap) returned them as ISO 8601 strings — which
// the FE shape logic and localeCompare-based sorting depend on. This helper
// converts every Date in a row to its ISO string so the wire format stays
// identical across the pg-pool refactor.
function rowsWithIsoDates<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(r => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out as T;
  });
}

export async function registerDataRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Bootstrap: mail accounts + contacts + messages in one round-trip ───
  app.get<{ Querystring: { limit?: string } }>("/bootstrap", auth, async (req, reply) => {
    // Opportunistic audit-log retention: 1% chance per /bootstrap to
    // delete rows older than 180 days. Async, doesn't block the response.
    maybeCleanupAuditLog(req);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const userId = req.authUser!.id;
    const pool = requirePool();
    // Refactored (v0.0.217) to fetch every block via direct pg-pool
    // (Supavisor pooler) instead of supabase-js / PostgREST. The old
    // path counted every row of every bootstrap response against
    // Supabase's egress quota — that's what pushed us past the free-
    // tier 5 GB/month and got the project briefly restricted. The
    // Supavisor pool sits on a separate billing dimension (DB compute
    // / connections, not API egress), so all of this traffic is now
    // effectively free egress-wise. The FE response shape is
    // unchanged so no FE updates needed.
    //
    // Phase 1 (this block): metadata only — body_text + body_html
    // are NOT selected from messages so the payload stays small.
    // Phase 2 below pulls bodies for "actionable" messages only.
    let accountsRows: Record<string, unknown>[];
    let contactsRows: Record<string, unknown>[];
    let contactEmailsRows: Array<{ contact_id: string; email: string; is_news: boolean | null; is_no_reply: boolean | null; is_muted: boolean | null }>;
    let messagesRows: Record<string, unknown>[];
    let draftsRows: Record<string, unknown>[];
    let tagsRows: Record<string, unknown>[];
    let msgTagsRows: Array<{ message_id: string; tag_id: string }>;
    let r2mRows: Array<{ message_id: string; dismissed_at: string | null; snooze_until: string | null; snooze_count: number }>;
    let sigsRows: Record<string, unknown>[];
    let accSigsRows: Array<{ mail_account_id: string; signature_id: string; is_auto: boolean }>;
    let draftAttsRows: Record<string, unknown>[];
    let hidesRows: Array<{ message_id: string; contact_id: string }>;
    try {
      const [
        accountsR, contactsR, contactEmailsR, messagesR, draftsR, tagsR,
        msgTagsR, r2mR, sigsR, accSigsR, draftAttsR, hidesR,
      ] = await Promise.all([
        pool.query(`SELECT id, email, display_name, provider, last_sync_at, auto_sync,
                           retention_deleted_days, retention_spam_days, sync_known_uids
                      FROM mail_accounts WHERE user_id = $1 ORDER BY created_at ASC`, [userId]),
        pool.query(`SELECT id, name, org, color, portrait_url, r2m_days, primary_email,
                           archived_at, deleted_at, is_news, is_no_reply, is_muted, mute_reason
                      FROM contacts WHERE user_id = $1 ORDER BY name ASC`, [userId]),
        pool.query(`SELECT contact_id, email, is_news, is_no_reply, is_muted
                      FROM contact_emails WHERE user_id = $1`, [userId]),
        pool.query(`SELECT id, mail_account_id, folder, uid, message_id, thread_id,
                           from_email, from_name, to_emails, subject, snippet, date, flags,
                           direction, deleted_at, spam, has_attachments, attachments_meta,
                           unsubscribe_url, unsubscribe_one_click
                      FROM messages
                     WHERE user_id = $1
                     ORDER BY date DESC LIMIT $2`, [userId, limit]),
        pool.query(`SELECT id, mail_account_id, to_emails, cc_emails, bcc_emails,
                           subject, body, reply_to_message_id, tags, created_at, modified_at
                      FROM drafts WHERE user_id = $1 ORDER BY modified_at DESC`, [userId]),
        pool.query(`SELECT id, name, archived_at, created_at, email_roles
                      FROM tags WHERE user_id = $1 ORDER BY name ASC`, [userId]),
        pool.query(`SELECT message_id, tag_id FROM message_tags WHERE user_id = $1`, [userId]),
        pool.query(`SELECT message_id, dismissed_at, snooze_until, snooze_count
                      FROM r2m_state WHERE user_id = $1`, [userId]),
        pool.query(`SELECT id, title, body, created_at
                      FROM signatures WHERE user_id = $1 ORDER BY created_at ASC`, [userId]),
        pool.query(`SELECT mail_account_id, signature_id, is_auto
                      FROM account_signatures WHERE user_id = $1`, [userId]),
        pool.query(`SELECT id, draft_id, filename, content_type, size, created_at
                      FROM draft_attachments WHERE user_id = $1 ORDER BY created_at ASC`, [userId]),
        pool.query(`SELECT message_id, contact_id
                      FROM message_contact_hides WHERE user_id = $1`, [userId]),
      ]);
      accountsRows      = rowsWithIsoDates(accountsR.rows);
      // Merge contact_emails into each contact under the same key the FE
      // used to receive from supabase-js's nested embedded select.
      const contactEmailsByContact = new Map<string, Array<{ email: string; is_news: boolean | null; is_no_reply: boolean | null; is_muted: boolean | null }>>();
      contactEmailsRows = contactEmailsR.rows;
      for (const ce of contactEmailsRows) {
        const arr = contactEmailsByContact.get(ce.contact_id) ?? [];
        arr.push({ email: ce.email, is_news: ce.is_news, is_no_reply: ce.is_no_reply, is_muted: ce.is_muted });
        contactEmailsByContact.set(ce.contact_id, arr);
      }
      contactsRows = rowsWithIsoDates(contactsR.rows).map(c => ({
        ...c,
        contact_emails: contactEmailsByContact.get(c.id as string) ?? [],
      }));
      messagesRows  = rowsWithIsoDates(messagesR.rows);
      draftsRows    = rowsWithIsoDates(draftsR.rows);
      tagsRows      = rowsWithIsoDates(tagsR.rows);
      msgTagsRows   = msgTagsR.rows;
      r2mRows       = rowsWithIsoDates(r2mR.rows) as typeof r2mRows;
      sigsRows      = rowsWithIsoDates(sigsR.rows);
      accSigsRows   = accSigsR.rows;
      draftAttsRows = rowsWithIsoDates(draftAttsR.rows);
      hidesRows     = hidesR.rows;
    } catch (e) {
      return sendTransientOr500(reply, e);
    }

    // Per-account synced count for the user-menu progress display, via
    // direct pg GROUP BY. This is matched against sync_known_uids (the
    // server-side IMAP UID search count) to render "X of Y mails".
    // INCLUDES soft-deleted rows on purpose: the user-perceived question
    // "are all UIDs in scope present in our DB?" is yes whether or not
    // a particular mail later got soft-deleted. Excluding deleted_at
    // rows used to leave a permanent gap equal to the soft-delete count
    // (e.g. "1066 of 1115" never closing because 49 were deleted).
    let messageCountByAccount: Record<string, number> = {};
    try {
      const pool = requirePool();
      const cntRes = await pool.query<{ mail_account_id: string; cnt: string }>(
        `SELECT mail_account_id, COUNT(*)::text AS cnt
           FROM messages
          WHERE user_id = $1
          GROUP BY mail_account_id`,
        [req.authUser!.id],
      );
      messageCountByAccount = Object.fromEntries(
        cntRes.rows.map(r => [r.mail_account_id, Number(r.cnt)]),
      );
    } catch (e) {
      // Non-fatal: the rest of the bootstrap is still useful even if
      // the count failed. Log and surface zeros — the FE just won't
      // show a progress fraction for affected accounts this round.
      req.log.warn({ err: e }, "bootstrap: per-account count failed (non-fatal)");
    }

    // Per-contact: which mail_accounts has the user seen mail involving
    // this contact in (sender OR recipient). Computed over EVERY message
    // in the DB so contacts whose mails happen to fall outside the top-
    // 500 bootstrap window still get a populated accountEmails list on
    // the FE. Without this the left-column contact filter
    // `contact.accountEmails.some(ae => selAccounts.includes(ae))` hid
    // valid contacts (Marco, Dave, …) whose mails sat below the
    // bootstrap cutoff.
    let contactAccountEmails: Record<string, string[]> = {};
    try {
      const pool = requirePool();
      // email columns are TEXT (not citext — extension isn't installed),
      // so we lowercase both sides for case-insensitive matching.
      // LOWER() the account email too — the FE's selAccounts state and
      // accountEmailById map are both lowercased, so a mail_account row
      // with email "Stefan" (capital S, as Stefan accidentally entered
      // during onboarding) mismatched contact.accountEmails ("Stefan")
      // against selAccounts ("stefan") and his entire contact list
      // disappeared from the LeftColumn visibility filter. Normalising
      // here makes the comparison case-insensitive end-to-end.
      const cae = await pool.query<{ contact_id: string; account_emails: string[] }>(
        `WITH per_msg AS (
           SELECT LOWER(ma.email) AS account_email, ce.contact_id
             FROM messages m
             JOIN mail_accounts ma ON ma.id = m.mail_account_id
             JOIN contact_emails ce ON LOWER(ce.email) = LOWER(m.from_email)
            WHERE m.user_id = $1
            UNION ALL
           SELECT LOWER(ma.email) AS account_email, ce.contact_id
             FROM messages m
             JOIN mail_accounts ma ON ma.id = m.mail_account_id
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.to_emails, '[]'::jsonb)) te
             JOIN contact_emails ce ON LOWER(ce.email) = LOWER(te->>'email')
            WHERE m.user_id = $1
         )
         SELECT contact_id, ARRAY_AGG(DISTINCT account_email) AS account_emails
           FROM per_msg
          GROUP BY contact_id`,
        [req.authUser!.id],
      );
      contactAccountEmails = Object.fromEntries(
        cae.rows.map(r => [r.contact_id, r.account_emails]),
      );
    } catch (e) {
      // Non-fatal: FE falls back to the message-derived computation
      // (top-500 only), which is what the app did before this query.
      req.log.warn({ err: e }, "bootstrap: contact↔account mapping failed (non-fatal)");
    }

    // Per-contact aggregate stats over ALL messages, so the FE can
    // sort the contact list (and show badges) without depending on
    // whatever happens to be in the top-500 messages payload. Three
    // numbers per contact:
    //   latest_date  — newest non-deleted, non-draft message that
    //                  involves the contact (sender OR recipient)
    //   unread       — incoming non-deleted, non-draft, !seen mails
    //   r2m          — outgoing mails with an armed (not dismissed)
    //                  r2m_state row
    // Each runs as its own query; merged client-side. Non-fatal if
    // any of them fails — FE drops back to message-derived metrics.
    let contactStats: Record<string, { latest_date: string | null; unread: number; r2m: number }> = {};
    try {
      const pool = requirePool();
      // Distinct (contact_id, message) pairs across from/to matches —
      // a single physical mail counts once per contact involvement.
      const baseCte = `
        WITH per_msg AS (
          SELECT ce.contact_id, m.id, m.date, m.flags, m.direction, m.deleted_at
            FROM messages m
            JOIN contact_emails ce ON LOWER(ce.email) = LOWER(m.from_email)
           WHERE m.user_id = $1
          UNION
          SELECT ce.contact_id, m.id, m.date, m.flags, m.direction, m.deleted_at
            FROM messages m
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.to_emails, '[]'::jsonb)) te
            JOIN contact_emails ce ON LOWER(ce.email) = LOWER(te->>'email')
           WHERE m.user_id = $1
        )
      `;
      const statsRes = await pool.query<{ contact_id: string; latest_date: string | null; unread: string; r2m: string }>(
        baseCte + `
        SELECT
          contact_id,
          MAX(date) FILTER (WHERE deleted_at IS NULL AND NOT COALESCE((flags->>'draft')::bool, false)) AS latest_date,
          COUNT(*) FILTER (
            WHERE deleted_at IS NULL
              AND direction = 'in'
              AND NOT COALESCE((flags->>'seen')::bool, false)
              AND NOT COALESCE((flags->>'draft')::bool, false)
          )::text AS unread,
          0::text AS r2m
          FROM per_msg
         GROUP BY contact_id
        `,
        [req.authUser!.id],
      );
      // r2m: outgoing mail to a contact with an active r2m_state row.
      const r2mRes = await pool.query<{ contact_id: string; r2m: string }>(
        `WITH per_msg AS (
          SELECT ce.contact_id, m.id
            FROM messages m
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.to_emails, '[]'::jsonb)) te
            JOIN contact_emails ce ON LOWER(ce.email) = LOWER(te->>'email')
           WHERE m.user_id = $1
             AND m.direction = 'out'
             AND m.deleted_at IS NULL
         )
         SELECT pm.contact_id, COUNT(*)::text AS r2m
           FROM per_msg pm
           JOIN r2m_state rs ON rs.message_id = pm.id
          WHERE rs.dismissed_at IS NULL
          GROUP BY pm.contact_id`,
        [req.authUser!.id],
      );
      const r2mByContact = new Map<string, number>();
      for (const r of r2mRes.rows) r2mByContact.set(r.contact_id, Number(r.r2m));
      contactStats = Object.fromEntries(statsRes.rows.map(r => [r.contact_id, {
        latest_date: r.latest_date,
        unread: Number(r.unread),
        r2m: r2mByContact.get(r.contact_id) ?? 0,
      }]));
    } catch (e) {
      req.log.warn({ err: e }, "bootstrap: contact_stats failed (non-fatal)");
    }

    // Pull every actionable mail (unread incoming OR armed-r2m outgoing)
    // regardless of where they sit on the date axis, and merge them on
    // top of the date-desc top-`limit` slice. Without this, a contact
    // whose unread mail happens to be older than ~3-4 weeks back would
    // need a lazy-fetch on click before the unread badge / banner
    // appeared, contradicting the contract that "all new mail shows up
    // in the contact list immediately". Same column shape as the main
    // messages query so the existing FE shape logic handles them
    // identically; dedup on id keeps the top-`limit` rows authoritative.
    let extraActionableRows: Record<string, unknown>[] = [];
    try {
      const pool = requirePool();
      const extraRes = await pool.query(
        `SELECT m.id, m.mail_account_id, m.folder, m.uid, m.message_id, m.thread_id,
                m.from_email, m.from_name, m.to_emails,
                m.subject, m.snippet, m.date, m.flags, m.direction,
                m.deleted_at, m.spam, m.has_attachments, m.attachments_meta,
                m.unsubscribe_url, m.unsubscribe_one_click
           FROM messages m
          WHERE m.user_id = $1
            AND m.deleted_at IS NULL
            AND NOT COALESCE((m.flags->>'draft')::bool, false)
            AND (
              (m.direction = 'in' AND NOT COALESCE((m.flags->>'seen')::bool, false))
              OR EXISTS (
                SELECT 1 FROM r2m_state rs
                 WHERE rs.message_id = m.id AND rs.dismissed_at IS NULL
              )
            )
          ORDER BY m.date DESC`,
        [req.authUser!.id],
      );
      extraActionableRows = extraRes.rows as unknown as Record<string, unknown>[];
    } catch (e) {
      req.log.warn({ err: e }, "bootstrap: extra actionable fetch failed (non-fatal)");
    }
    const mergedMessages = (() => {
      const have = new Set(messagesRows.map(m => (m as { id: string }).id));
      const extras = extraActionableRows.filter(r => !have.has((r as { id: string }).id));
      return [...messagesRows, ...extras];
    })();

    // Phase 2: collect bodies for the "actionable" subset only — unread
    // incoming + active r2m, so the mails the user is most likely to
    // open are instant. The previous version also packed in the 300
    // newest bodies for client-side full-text search, which pushed
    // every /bootstrap to ~20MB for active accounts. With Supabase
    // free-tier egress at 5 GB/month and Realtime triggering a refresh
    // on each cross-device change, that easily burned the monthly
    // quota in a couple of days. Bodies are still cached per-message in
    // pg (attachments_meta path in /body, since v0.0.154), so the second
    // click on any mail is < 50 ms — same UX, ~40x less egress. Search
    // still works: snippet + subject + headers travel in this bootstrap;
    // bodies older than that route through /search server-side.
    const RECENT_BODY_LIMIT = 0;
    type R2mRow = { message_id: string; dismissed_at: string | null };
    type MsgMeta = { id: string; direction: string; flags: Record<string, unknown> | null; mail_account_id: string };
    type BodyRow = { id: string; body_text: string | null; body_html: string | null };
    const r2mTyped = r2mRows as unknown as R2mRow[];
    const messagesTyped = mergedMessages as unknown as MsgMeta[];
    const r2mActiveIds = new Set(
      r2mTyped.filter(r => r.dismissed_at === null).map(r => r.message_id),
    );
    const actionableIds = messagesTyped
      .filter(m => {
        if (r2mActiveIds.has(m.id)) return true;
        if (m.direction !== 'in') return false;
        const seen = (m.flags as { seen?: boolean } | null)?.seen;
        return !seen;
      })
      .map(m => m.id);
    // messagesTyped is already ordered by date desc, so slice the head.
    const recentIds = messagesTyped.slice(0, RECENT_BODY_LIMIT).map(m => m.id);
    const bodyTargetIds = Array.from(new Set([...actionableIds, ...recentIds]));
    const bodiesById = new Map<string, { body_text: string | null; body_html: string | null }>();
    if (bodyTargetIds.length > 0) {
      // Use direct pg, not supabase-js: a 300-id .in() filter serializes
      // into a ~17 KB URL ("?id=in.(uuid1,uuid2,...)") which exceeds
      // Supabase pgrest's HTTP header limit (16 KB) and fails the entire
      // request with UND_ERR_HEADERS_OVERFLOW. pg's $1::uuid[] keeps the
      // ids in the request body where there is no such limit, and the
      // user_id filter mirrors what RLS would have enforced anyway.
      try {
        const pool = requirePool();
        const bodiesRes = await pool.query<BodyRow>(
          `SELECT id, body_text, body_html
             FROM messages
            WHERE user_id = $1 AND id = ANY($2::uuid[])`,
          [req.authUser!.id, bodyTargetIds],
        );
        for (const row of bodiesRes.rows) {
          bodiesById.set(row.id, { body_text: row.body_text, body_html: row.body_html });
        }
      } catch (e) {
        return sendTransientOr500(reply, e);
      }
    }
    const messagesWithBodies = messagesTyped.map(m => {
      const body = bodiesById.get(m.id);
      return body ? { ...m, body_text: body.body_text, body_html: body.body_html } : m;
    });
    return {
      mail_accounts: accountsRows,
      contacts: contactsRows,
      messages: messagesWithBodies,
      drafts: draftsRows,
      tags: tagsRows,
      message_tags: msgTagsRows,
      r2m_state: r2mRows,
      signatures: sigsRows,
      account_signatures: accSigsRows,
      draft_attachments: draftAttsRows,
      message_contact_hides: hidesRows,
      message_count_by_account: messageCountByAccount,
      contact_account_emails: contactAccountEmails,
      contact_stats: contactStats,
    };
  });

  // ─── Search across the user's mail ──────────────────────────────────────
  // Used by the global search box to extend the client-side filter (which
  // only sees the cached subset) with hits from older mail. Single ILIKE
  // OR-query on subject / body_text / from_email, ordered by date desc.
  // Limit caps how many rows we ship back; the client merges them after
  // its own list.
  //
  // v0.0.218: switched from 3 parallel supabase-js .ilike() calls to a
  // single pg-pool query — the previous shape pulled body_text + body_html
  // for every hit through PostgREST (high egress) and ran three round-
  // trips. One OR-filtered SELECT is both cheaper egress-wise (Supavisor
  // pool, not API) and a single round-trip. JS-side dedup also disappears
  // because a single SELECT can't return the same id twice.
  app.get<{ Querystring: { q?: string; limit?: string } }>("/search", auth, async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return { messages: [] };
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const pool = requirePool();
    const pattern = `%${q}%`;
    try {
      const r = await pool.query(
        `SELECT id, mail_account_id, folder, uid, message_id, thread_id,
                from_email, from_name, to_emails, subject, snippet,
                body_text, body_html, date, flags, direction,
                deleted_at, spam, has_attachments
           FROM messages
          WHERE user_id = $1
            AND (subject ILIKE $2 OR body_text ILIKE $2 OR from_email ILIKE $2)
          ORDER BY date DESC
          LIMIT $3`,
        [req.authUser!.id, pattern, limit],
      );
      return { messages: rowsWithIsoDates(r.rows) };
    } catch (e) {
      return sendTransientOr500(reply, e);
    }
  });

  // ─── Contacts (with all emails) ─────────────────────────────────────────
  // Standalone endpoint — currently the FE only reads contacts via
  // /bootstrap. Kept for compatibility / direct calls. v0.0.218: switched
  // from supabase-js embedded select to a two-query pg-pool join (same
  // pattern as /bootstrap), keeping the FE wire-shape identical.
  app.get("/contacts", auth, async (req, reply) => {
    const pool = requirePool();
    const userId = req.authUser!.id;
    try {
      const [contactsR, emailsR] = await Promise.all([
        pool.query(`SELECT id, name, org, color, portrait_url, r2m_days, primary_email,
                           archived_at, is_news, is_no_reply, is_muted, mute_reason
                      FROM contacts WHERE user_id = $1 ORDER BY name ASC`, [userId]),
        pool.query<{ contact_id: string; email: string; is_news: boolean | null; is_no_reply: boolean | null; is_muted: boolean | null }>(
          `SELECT contact_id, email, is_news, is_no_reply, is_muted
             FROM contact_emails WHERE user_id = $1`, [userId]),
      ]);
      const emailsByContact = new Map<string, Array<{ email: string; is_news: boolean | null; is_no_reply: boolean | null; is_muted: boolean | null }>>();
      for (const e of emailsR.rows) {
        const arr = emailsByContact.get(e.contact_id) ?? [];
        arr.push({ email: e.email, is_news: e.is_news, is_no_reply: e.is_no_reply, is_muted: e.is_muted });
        emailsByContact.set(e.contact_id, arr);
      }
      const contacts = rowsWithIsoDates(contactsR.rows).map(c => ({
        ...c,
        contact_emails: emailsByContact.get(c.id as string) ?? [],
      }));
      return { contacts };
    } catch (e) {
      return sendTransientOr500(reply, e);
    }
  });

  // ─── Messages (cross-account, filtered by user via RLS) ─────────────────
  // Pagination endpoint with optional `before` cursor (date<…). FE doesn't
  // currently call this — /bootstrap is the only message-list source — but
  // it's kept available for future infinite-scroll / "load older" UI.
  // v0.0.218: pg-pool, same egress reasoning as /bootstrap.
  app.get<{ Querystring: { limit?: string; before?: string } }>("/messages", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const pool = requirePool();
    const params: unknown[] = [req.authUser!.id];
    let whereExtra = '';
    if (req.query.before) {
      params.push(req.query.before);
      whereExtra = ` AND date < $${params.length}`;
    }
    params.push(limit);
    try {
      const r = await pool.query(
        `SELECT id, mail_account_id, folder, uid, thread_id, from_email, from_name, to_emails,
                subject, snippet, body_text, date, flags, direction, deleted_at, spam, has_attachments
           FROM messages
          WHERE user_id = $1${whereExtra}
          ORDER BY date DESC
          LIMIT $${params.length}`,
        params,
      );
      return { messages: rowsWithIsoDates(r.rows) };
    } catch (e) {
      return sendTransientOr500(reply, e);
    }
  });

  // ─── Messages for one contact (lazy load) ───────────────────────────────
  // Bootstrap caps at the 500 most-recent mails. Contacts whose mails
  // sit below that cutoff (older relationships, low-volume senders)
  // still appear in the contact list — via the contact_account_emails
  // map — but the FE messageList has nothing for them. Clicking the
  // contact would otherwise show an empty thread. This endpoint pulls
  // every message that involves the contact (from_email OR any
  // recipient in to_emails matches one of the contact's emails). The
  // FE merges the result into messageList.
  app.get<{ Querystring: { contact?: string; limit?: string } }>(
    "/messages-for-contact",
    auth,
    async (req, reply) => {
      const contactId = (req.query.contact || "").trim();
      if (!contactId) return reply.badRequest("contact required");
      const limit = Math.min(Number(req.query.limit) || 300, 1000);

      const pool = requirePool();
      const userId = req.authUser!.id;

      // Resolve the contact's emails, scoped to this user.
      const ce = await pool.query<{ email: string }>(
        `SELECT email FROM contact_emails
          WHERE contact_id = $1 AND user_id = $2`,
        [contactId, userId],
      );
      if (ce.rows.length === 0) return { messages: [] };
      const emails = ce.rows.map(r => r.email.toLowerCase());

      // ANY-of array match on from_email OR any to_emails entry. Same
      // shape as /bootstrap.messages so the FE can apply its existing
      // shaping logic without case-splitting.
      const r = await pool.query(
        `SELECT m.id, m.mail_account_id, m.folder, m.uid, m.message_id, m.thread_id,
                m.from_email, m.from_name, m.to_emails,
                m.subject, m.snippet, m.date, m.flags, m.direction,
                m.deleted_at, m.spam, m.has_attachments, m.attachments_meta,
                m.unsubscribe_url, m.unsubscribe_one_click
           FROM messages m
          WHERE m.user_id = $1
            AND (
              LOWER(m.from_email) = ANY($2::text[])
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(m.to_emails, '[]'::jsonb)) te
                 WHERE LOWER(te->>'email') = ANY($2::text[])
              )
            )
          ORDER BY m.date DESC
          LIMIT $3`,
        [userId, emails, limit],
      );
      return { messages: r.rows };
    },
  );
}
