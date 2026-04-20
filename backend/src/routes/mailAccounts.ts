import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { encrypt, decrypt } from "../crypto.js";
import { testImapConnection } from "../imap.js";
import { authPreHandler } from "../auth.js";
import { syncAccount } from "../sync.js";
import { requirePool } from "../db.js";

interface AccountInput {
  email: string;
  provider: "generic" | "icloud" | "gmail";
  display_name?: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_password?: string;
}

export async function registerMailAccountsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── List accounts (no secrets) ─────────────────────────────────────────
  app.get("/mail-accounts", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("mail_accounts")
      .select("id, email, provider, display_name, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, last_sync_at, last_error, created_at")
      .order("created_at", { ascending: true });
    if (error) return reply.internalServerError(error.message);
    return { accounts: data };
  });

  // ─── Test connection without saving (for "Test & save" UX) ──────────────
  app.post<{ Body: AccountInput }>("/mail-accounts/test", auth, async (req, reply) => {
    const b = req.body;
    if (!b.imap_host || !b.imap_port || !b.imap_user || !b.imap_password) {
      return reply.badRequest("imap_host, imap_port, imap_user, imap_password required");
    }
    const result = await testImapConnection({
      host: b.imap_host,
      port: b.imap_port,
      user: b.imap_user,
      pass: b.imap_password,
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, mailboxCount: result.mailboxCount };
  });

  // ─── Create account (credentials encrypted at rest) ─────────────────────
  app.post<{ Body: AccountInput }>("/mail-accounts", auth, async (req, reply) => {
    const b = req.body;
    if (!b.email || !b.provider) return reply.badRequest("email and provider required");

    // Use direct pg for bytea fields — supabase-js serializes Buffer as JSON object.
    const pool = requirePool();
    const imapEnc = b.imap_password ? encrypt(b.imap_password) : null;
    const smtpEnc = b.smtp_password ? encrypt(b.smtp_password) : null;
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO mail_accounts (
           user_id, email, provider, display_name,
           imap_host, imap_port, imap_user, imap_cred_enc,
           smtp_host, smtp_port, smtp_user, smtp_cred_enc
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, email, provider, display_name, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, created_at`,
        [
          req.authUser!.id, b.email, b.provider, b.display_name ?? null,
          b.imap_host ?? null, b.imap_port ?? null, b.imap_user ?? null, imapEnc,
          b.smtp_host ?? null, b.smtp_port ?? null, b.smtp_user ?? null, smtpEnc,
        ],
      );
      return { account: r.rows[0] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate key")) return reply.conflict("An account with this email already exists");
      return reply.internalServerError(msg);
    }
  });

  // ─── Delete account ─────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/mail-accounts/:id", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("mail_accounts").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });

  // ─── Sync account (fetch last 90d INBOX + Sent, upsert messages + contacts) ─
  app.post<{ Params: { id: string } }>("/mail-accounts/:id/sync", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM mail_accounts WHERE id = $1`, [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const result = await syncAccount(req.params.id);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  // ─── List synced messages for an account (MVP: latest N) ────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/mail-accounts/:id/messages", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("messages")
      .select("id, folder, uid, from_email, from_name, subject, snippet, date, direction, flags")
      .eq("mail_account_id", req.params.id)
      .order("date", { ascending: false })
      .limit(limit);
    if (error) return reply.internalServerError(error.message);
    return { messages: data };
  });

  // ─── Test connection for existing saved account ─────────────────────────
  app.post<{ Params: { id: string } }>("/mail-accounts/:id/test", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{
      user_id: string; imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null;
    }>(
      `SELECT user_id, imap_host, imap_port, imap_user, imap_cred_enc
         FROM mail_accounts WHERE id = $1`,
      [req.params.id],
    );
    const row = r.rows[0];
    if (!row) return reply.notFound("Account not found");
    if (row.user_id !== req.authUser!.id) return reply.forbidden();
    if (!row.imap_cred_enc) return reply.badRequest("No stored IMAP password");

    const password = decrypt(row.imap_cred_enc);
    const result = await testImapConnection({
      host: row.imap_host, port: row.imap_port,
      user: row.imap_user, pass: password,
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, mailboxCount: result.mailboxCount };
  });
}
