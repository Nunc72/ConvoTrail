// Drafts CRUD. Drafts are created/updated explicitly via "Save draft" in
// Compose; closing without saving persists nothing. Drafts are read via
// /bootstrap, so there is no dedicated GET here.
import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";

function splitAddresses(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function toJsonEmails(s: string | undefined, role: "to" | "cc" | "bcc") {
  return splitAddresses(s).map(email => ({ email, role }));
}

interface DraftBody {
  mail_account_id?: string | null;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  reply_to_id?: string | null;
}

export async function registerDraftsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Create draft ────────────────────────────────────────────────────────
  app.post<{ Body: DraftBody }>("/drafts", auth, async (req, reply) => {
    const b = req.body || {};
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("drafts")
      .insert({
        user_id: req.authUser!.id,
        mail_account_id: b.mail_account_id || null,
        to_emails: toJsonEmails(b.to, "to"),
        cc_emails: toJsonEmails(b.cc, "cc"),
        bcc_emails: toJsonEmails(b.bcc, "bcc"),
        subject: b.subject ?? null,
        body: b.body ?? null,
        reply_to_message_id: b.reply_to_id || null,
      })
      .select("id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, reply_to_message_id, created_at, modified_at")
      .single();
    if (error) return reply.internalServerError(error.message);
    return { draft: data };
  });

  // ─── Update draft (partial; any provided field replaces, null allowed) ───
  app.patch<{ Params: { id: string }; Body: DraftBody }>("/drafts/:id", auth, async (req, reply) => {
    const { id } = req.params;
    const b = req.body || {};
    const pool = requirePool();

    const r0 = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM drafts WHERE id = $1`, [id],
    );
    if (r0.rows.length === 0) return reply.notFound();
    if (r0.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const sets: string[] = ["modified_at = now()"];
    const vals: unknown[] = [];
    let p = 1;
    const setField = (col: string, val: unknown) => { sets.push(`${col} = $${p++}`); vals.push(val); };

    if (b.mail_account_id !== undefined) setField("mail_account_id", b.mail_account_id || null);
    if (b.to !== undefined)              setField("to_emails", JSON.stringify(toJsonEmails(b.to, "to")));
    if (b.cc !== undefined)              setField("cc_emails", JSON.stringify(toJsonEmails(b.cc, "cc")));
    if (b.bcc !== undefined)             setField("bcc_emails", JSON.stringify(toJsonEmails(b.bcc, "bcc")));
    if (b.subject !== undefined)         setField("subject", b.subject ?? null);
    if (b.body !== undefined)            setField("body", b.body ?? null);
    if (b.reply_to_id !== undefined)     setField("reply_to_message_id", b.reply_to_id || null);

    vals.push(id);
    await pool.query(`UPDATE drafts SET ${sets.join(", ")} WHERE id = $${p}`, vals);
    return reply.code(204).send();
  });

  // ─── Delete draft ────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/drafts/:id", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("drafts").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });
}
