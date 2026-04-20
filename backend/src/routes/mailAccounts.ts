import type { FastifyInstance } from "fastify";
import { supabaseWithJwt, supabaseAdmin } from "../supabase.js";
import { encrypt, decrypt } from "../crypto.js";
import { testImapConnection } from "../imap.js";
import { authPreHandler } from "../auth.js";

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
    if (!supabaseAdmin) return reply.internalServerError("Service key not configured");

    const row: Record<string, unknown> = {
      user_id: req.authUser!.id,
      email: b.email,
      provider: b.provider,
      display_name: b.display_name ?? null,
      imap_host: b.imap_host ?? null,
      imap_port: b.imap_port ?? null,
      imap_user: b.imap_user ?? null,
      smtp_host: b.smtp_host ?? null,
      smtp_port: b.smtp_port ?? null,
      smtp_user: b.smtp_user ?? null,
    };
    if (b.imap_password) row.imap_cred_enc = encrypt(b.imap_password);
    if (b.smtp_password) row.smtp_cred_enc = encrypt(b.smtp_password);

    // Insert via service-role because bytea columns via PostgREST + RLS are a PITA; we enforce user_id manually.
    const { data, error } = await supabaseAdmin
      .from("mail_accounts")
      .insert(row)
      .select("id, email, provider, display_name, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, created_at")
      .single();
    if (error) return reply.internalServerError(error.message);
    return { account: data };
  });

  // ─── Delete account ─────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/mail-accounts/:id", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("mail_accounts").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });

  // ─── Test connection for existing saved account ─────────────────────────
  app.post<{ Params: { id: string } }>("/mail-accounts/:id/test", auth, async (req, reply) => {
    if (!supabaseAdmin) return reply.internalServerError("Service key not configured");
    const { data, error } = await supabaseAdmin
      .from("mail_accounts")
      .select("user_id, imap_host, imap_port, imap_user, imap_cred_enc")
      .eq("id", req.params.id)
      .single();
    if (error || !data) return reply.notFound("Account not found");
    if (data.user_id !== req.authUser!.id) return reply.forbidden();
    if (!data.imap_cred_enc) return reply.badRequest("No stored IMAP password");

    // Supabase returns bytea as "\x<hex>" string
    const raw: string = data.imap_cred_enc as unknown as string;
    const buf = Buffer.from(raw.startsWith("\\x") ? raw.slice(2) : raw, "hex");
    const password = decrypt(buf);

    const result = await testImapConnection({
      host: data.imap_host!,
      port: data.imap_port!,
      user: data.imap_user!,
      pass: password,
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, mailboxCount: result.mailboxCount };
  });
}
