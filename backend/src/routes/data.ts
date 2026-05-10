import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";

export async function registerDataRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Bootstrap: mail accounts + contacts + messages in one round-trip ───
  app.get<{ Querystring: { limit?: string } }>("/bootstrap", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const sb = supabaseWithJwt(req.authJwt!);
    // Phase 1: metadata only — body_text and body_html are excluded from
    // the messages select so the bootstrap payload stays small. Bodies are
    // fetched in phase 2 below for the messages the user is most likely
    // to open immediately (unread incoming + active revert-to-me). The
    // detail view falls back to GET /messages/:id/body for everything
    // else, fetched on demand when the user opens a message.
    const [accountsRes, contactsRes, messagesRes, draftsRes, tagsRes, msgTagsRes, r2mRes, sigsRes, accSigsRes, draftAttsRes, msgCountsRes] = await Promise.all([
      sb.from("mail_accounts").select(
        "id, email, display_name, provider, last_sync_at, auto_sync, " +
        "retention_deleted_days, retention_spam_days, sync_known_uids",
      ).order("created_at", { ascending: true }),
      sb.from("contacts").select(
        "id, name, org, color, portrait_url, r2m_days, primary_email, archived_at, " +
        "is_news, is_muted, " +
        "contact_emails(email, is_news, is_muted)",
      ).order("name", { ascending: true }),
      sb.from("messages").select(
        "id, mail_account_id, folder, uid, message_id, thread_id, from_email, from_name, to_emails, " +
        "subject, snippet, date, flags, direction, deleted_at, has_attachments",
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
      // Per-account synced count for the user-menu progress display.
      // Excludes soft-deleted rows since those don't contribute to "X / Y
      // synced".
      sb.from("messages").select("mail_account_id", { count: "exact", head: false })
        .is("deleted_at", null),
    ]);
    if (accountsRes.error) return reply.internalServerError(accountsRes.error.message);
    if (contactsRes.error) return reply.internalServerError(contactsRes.error.message);
    if (messagesRes.error) return reply.internalServerError(messagesRes.error.message);
    if (draftsRes.error)   return reply.internalServerError(draftsRes.error.message);
    if (tagsRes.error)     return reply.internalServerError(tagsRes.error.message);
    if (msgTagsRes.error)  return reply.internalServerError(msgTagsRes.error.message);
    if (r2mRes.error)      return reply.internalServerError(r2mRes.error.message);
    if (sigsRes.error)     return reply.internalServerError(sigsRes.error.message);
    if (accSigsRes.error)  return reply.internalServerError(accSigsRes.error.message);
    if (draftAttsRes.error) return reply.internalServerError(draftAttsRes.error.message);
    if (msgCountsRes.error) return reply.internalServerError(msgCountsRes.error.message);

    // Phase 2: collect bodies for two sets so the client has them ready:
    //   (a) the "actionable" subset — unread incoming + active r2m, so
    //       the mails the user is most likely to open are instant;
    //   (b) the 300 newest messages by date, so client-side search
    //       covers ~3-4 weeks of recent mail without a network round
    //       trip. Anything older still searches via /search.
    // RLS constrains the query to the user's own rows.
    const RECENT_BODY_LIMIT = 300;
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
      const bodiesRes = await sb.from("messages")
        .select("id, body_text, body_html")
        .in("id", bodyTargetIds);
      if (bodiesRes.error) return reply.internalServerError(bodiesRes.error.message);
      for (const row of ((bodiesRes.data ?? []) as unknown as BodyRow[])) {
        bodiesById.set(row.id, { body_text: row.body_text, body_html: row.body_html });
      }
    }
    // Aggregate per-account counts. The Supabase head:false count returns
    // the rows themselves; we just tally them by mail_account_id.
    const messageCountByAccount: Record<string, number> = {};
    for (const row of ((msgCountsRes.data ?? []) as unknown as { mail_account_id: string }[])) {
      messageCountByAccount[row.mail_account_id] = (messageCountByAccount[row.mail_account_id] ?? 0) + 1;
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
      "subject, snippet, body_text, body_html, date, flags, direction, deleted_at, has_attachments";
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
        "contact_emails(email, is_news, is_muted)",
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
        "subject, snippet, body_text, date, flags, direction, deleted_at, has_attachments",
      )
      .order("date", { ascending: false })
      .limit(limit);
    if (req.query.before) q = q.lt("date", req.query.before);
    const { data, error } = await q;
    if (error) return reply.internalServerError(error.message);
    return { messages: data };
  });
}
