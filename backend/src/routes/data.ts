import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";

export async function registerDataRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Bootstrap: mail accounts + contacts + messages in one round-trip ───
  app.get<{ Querystring: { limit?: string } }>("/bootstrap", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const sb = supabaseWithJwt(req.authJwt!);
    const [accountsRes, contactsRes, messagesRes, draftsRes] = await Promise.all([
      sb.from("mail_accounts").select(
        "id, email, display_name, provider, last_sync_at, auto_sync, " +
        "retention_deleted_days, retention_spam_days",
      ).order("created_at", { ascending: true }),
      sb.from("contacts").select(
        "id, name, org, color, portrait_url, r2m_days, primary_email, archived_at, " +
        "contact_emails(email, is_news, is_muted)",
      ).order("name", { ascending: true }),
      sb.from("messages").select(
        "id, mail_account_id, folder, uid, thread_id, from_email, from_name, to_emails, " +
        "subject, snippet, body_text, date, flags, direction, deleted_at, has_attachments",
      ).order("date", { ascending: false }).limit(limit),
      sb.from("drafts").select(
        "id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, " +
        "reply_to_message_id, created_at, modified_at",
      ).order("modified_at", { ascending: false }),
    ]);
    if (accountsRes.error) return reply.internalServerError(accountsRes.error.message);
    if (contactsRes.error) return reply.internalServerError(contactsRes.error.message);
    if (messagesRes.error) return reply.internalServerError(messagesRes.error.message);
    if (draftsRes.error)   return reply.internalServerError(draftsRes.error.message);
    return {
      mail_accounts: accountsRes.data,
      contacts: contactsRes.data,
      messages: messagesRes.data,
      drafts: draftsRes.data,
    };
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
