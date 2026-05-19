import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";
import { maybeCleanupAuditLog } from "../audit.js";
import { sendTransientOr500 } from "../errors.js";
import { requirePool } from "../db.js";

export async function registerDataRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Bootstrap: mail accounts + contacts + messages in one round-trip ───
  app.get<{ Querystring: { limit?: string } }>("/bootstrap", auth, async (req, reply) => {
    // Opportunistic audit-log retention: 1% chance per /bootstrap to
    // delete rows older than 180 days. Async, doesn't block the response.
    maybeCleanupAuditLog(req);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const sb = supabaseWithJwt(req.authJwt!);
    // Phase 1: metadata only — body_text and body_html are excluded from
    // the messages select so the bootstrap payload stays small. Bodies are
    // fetched in phase 2 below for the messages the user is most likely
    // to open immediately (unread incoming + active revert-to-me). The
    // detail view falls back to GET /messages/:id/body for everything
    // else, fetched on demand when the user opens a message.
    const [accountsRes, contactsRes, messagesRes, draftsRes, tagsRes, msgTagsRes, r2mRes, sigsRes, accSigsRes, draftAttsRes] = await Promise.all([
      sb.from("mail_accounts").select(
        "id, email, display_name, provider, last_sync_at, auto_sync, " +
        "retention_deleted_days, retention_spam_days, sync_known_uids",
      ).order("created_at", { ascending: true }),
      sb.from("contacts").select(
        "id, name, org, color, portrait_url, r2m_days, primary_email, archived_at, " +
        "is_news, is_no_reply, is_muted, mute_reason, " +
        "contact_emails(email, is_news, is_no_reply, is_muted)",
      ).order("name", { ascending: true }),
      sb.from("messages").select(
        "id, mail_account_id, folder, uid, message_id, thread_id, from_email, from_name, to_emails, " +
        "subject, snippet, date, flags, direction, deleted_at, spam, has_attachments, " +
        "attachments_meta, " +
        "unsubscribe_url, unsubscribe_one_click",
      ).order("date", { ascending: false }).limit(limit),
      sb.from("drafts").select(
        "id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, " +
        "reply_to_message_id, tags, created_at, modified_at",
      ).order("modified_at", { ascending: false }),
      sb.from("tags").select("id, name, archived_at, created_at, email_roles")
        .order("name", { ascending: true }),
      sb.from("message_tags").select("message_id, tag_id"),
      sb.from("r2m_state").select("message_id, dismissed_at, snooze_until, snooze_count"),
      sb.from("signatures").select("id, title, body, created_at")
        .order("created_at", { ascending: true }),
      sb.from("account_signatures").select("mail_account_id, signature_id, is_auto"),
      sb.from("draft_attachments").select("id, draft_id, filename, content_type, size, created_at")
        .order("created_at", { ascending: true }),
    ]);
    // Any of these can carry a wrapped "fetch failed" or pooler-drop —
    // route through sendTransientOr500 so the client gets a 503 it can
    // safely retry instead of a confusing 500.
    if (accountsRes.error) return sendTransientOr500(reply, accountsRes.error);
    if (contactsRes.error) return sendTransientOr500(reply, contactsRes.error);
    if (messagesRes.error) return sendTransientOr500(reply, messagesRes.error);
    if (draftsRes.error)   return sendTransientOr500(reply, draftsRes.error);
    if (tagsRes.error)     return sendTransientOr500(reply, tagsRes.error);
    if (msgTagsRes.error)  return sendTransientOr500(reply, msgTagsRes.error);
    if (r2mRes.error)      return sendTransientOr500(reply, r2mRes.error);
    if (sigsRes.error)     return sendTransientOr500(reply, sigsRes.error);
    if (accSigsRes.error)  return sendTransientOr500(reply, accSigsRes.error);
    if (draftAttsRes.error) return sendTransientOr500(reply, draftAttsRes.error);

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
      const cae = await pool.query<{ contact_id: string; account_emails: string[] }>(
        `WITH per_msg AS (
           SELECT ma.email AS account_email, ce.contact_id
             FROM messages m
             JOIN mail_accounts ma ON ma.id = m.mail_account_id
             JOIN contact_emails ce ON LOWER(ce.email) = LOWER(m.from_email)
            WHERE m.user_id = $1
            UNION ALL
           SELECT ma.email AS account_email, ce.contact_id
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
    const r2mRows = (r2mRes.data ?? []) as unknown as R2mRow[];
    const messagesRows = (messagesRes.data ?? []) as unknown as MsgMeta[];
    const r2mActiveIds = new Set(
      r2mRows.filter(r => r.dismissed_at === null).map(r => r.message_id),
    );
    const actionableIds = messagesRows
      .filter(m => {
        if (r2mActiveIds.has(m.id)) return true;
        if (m.direction !== 'in') return false;
        const seen = (m.flags as { seen?: boolean } | null)?.seen;
        return !seen;
      })
      .map(m => m.id);
    // messagesRows is already ordered by date desc, so slice the head.
    const recentIds = messagesRows.slice(0, RECENT_BODY_LIMIT).map(m => m.id);
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
    const messagesWithBodies = messagesRows.map(m => {
      const body = bodiesById.get(m.id);
      return body ? { ...m, body_text: body.body_text, body_html: body.body_html } : m;
    });
    return {
      mail_accounts: accountsRes.data,
      contacts: contactsRes.data,
      messages: messagesWithBodies,
      drafts: draftsRes.data,
      tags: tagsRes.data,
      message_tags: msgTagsRes.data,
      r2m_state: r2mRes.data,
      signatures: sigsRes.data,
      account_signatures: accSigsRes.data,
      draft_attachments: draftAttsRes.data,
      message_count_by_account: messageCountByAccount,
      contact_account_emails: contactAccountEmails,
    };
  });

  // ─── Search across the user's mail ──────────────────────────────────────
  // Used by the global search box to extend the client-side filter (which
  // only sees the cached subset) with hits from older mail. Three parallel
  // ILIKE queries on subject / body_text / from_email, deduped and sorted
  // by date desc. Limit caps how many rows we ship back; the client merges
  // them after its own list.
  app.get<{ Querystring: { q?: string; limit?: string } }>("/search", auth, async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return { messages: [] };
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const sb = supabaseWithJwt(req.authJwt!);
    const cols =
      "id, mail_account_id, folder, uid, message_id, thread_id, from_email, from_name, to_emails, " +
      "subject, snippet, body_text, body_html, date, flags, direction, deleted_at, spam, has_attachments";
    const pattern = `%${q}%`;
    const [subjectRes, bodyRes, fromRes] = await Promise.all([
      sb.from("messages").select(cols).ilike("subject", pattern).order("date", { ascending: false }).limit(limit),
      sb.from("messages").select(cols).ilike("body_text", pattern).order("date", { ascending: false }).limit(limit),
      sb.from("messages").select(cols).ilike("from_email", pattern).order("date", { ascending: false }).limit(limit),
    ]);
    if (subjectRes.error) return reply.internalServerError(subjectRes.error.message);
    if (bodyRes.error)    return reply.internalServerError(bodyRes.error.message);
    if (fromRes.error)    return reply.internalServerError(fromRes.error.message);
    type Row = { id: string; date: string | null };
    const seen = new Set<string>();
    const merged: Row[] = [];
    for (const row of ([...((subjectRes.data ?? []) as unknown as Row[]), ...((bodyRes.data ?? []) as unknown as Row[]), ...((fromRes.data ?? []) as unknown as Row[])])) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return { messages: merged.slice(0, limit) };
  });

  // ─── Contacts (with all emails) ─────────────────────────────────────────
  app.get("/contacts", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("contacts")
      .select(
        "id, name, org, color, portrait_url, r2m_days, primary_email, archived_at, " +
        "is_news, is_no_reply, is_muted, mute_reason, " +
        "contact_emails(email, is_news, is_no_reply, is_muted)",
      )
      .order("name", { ascending: true });
    if (error) return reply.internalServerError(error.message);
    return { contacts: data };
  });

  // ─── Messages (cross-account, filtered by user via RLS) ─────────────────
  app.get<{ Querystring: { limit?: string; before?: string } }>("/messages", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const sb = supabaseWithJwt(req.authJwt!);
    let q = sb
      .from("messages")
      .select(
        "id, mail_account_id, folder, uid, thread_id, from_email, from_name, to_emails, " +
        "subject, snippet, body_text, date, flags, direction, deleted_at, spam, has_attachments",
      )
      .order("date", { ascending: false })
      .limit(limit);
    if (req.query.before) q = q.lt("date", req.query.before);
    const { data, error } = await q;
    if (error) return reply.internalServerError(error.message);
    return { messages: data };
  });
}
