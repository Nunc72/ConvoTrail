// Public invite endpoints. Admin creates the invite token via the CLI
// (backend/src/invite.ts). The tester clicks the link, the frontend fetches
// GET /invites/:token to pre-fill their email, and posts POST /invites/:token/accept
// with their chosen password. We create the Supabase user with the admin API
// (bypasses the signup-disabled flag) and mark the invite used.
import type { FastifyInstance } from "fastify";
import { supabaseAdmin } from "../supabase.js";
import { requirePool } from "../db.js";
import { encrypt } from "../crypto.js";

interface AcceptBody {
  password: string;
  display_name?: string;
  imap?: {
    host: string;
    port: number;
    user: string;
    password: string;
    smtp_host?: string;
    smtp_port?: number;
  };
}

export async function registerInvitesRoutes(app: FastifyInstance) {
  // ─── Inspect an invite (public) ──────────────────────────────────────────
  app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ email: string | null; expires_at: string | null; used_at: string | null }>(
      `SELECT email, expires_at, used_at FROM invites WHERE token = $1`, [req.params.token],
    );
    if (r.rows.length === 0) return reply.code(404).send({ ok: false, error: "Invite not found" });
    const inv = r.rows[0];
    if (inv.used_at) return reply.code(410).send({ ok: false, error: "Invite already used" });
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
      return reply.code(410).send({ ok: false, error: "Invite expired" });
    }
    return { ok: true, email: inv.email || null };
  });

  // ─── Accept an invite → create user + first mail account (public) ───────
  // A single atomic-ish call so the onboarding UI doesn't have to sign the
  // user in (and trigger a page swap) before asking for IMAP details. When
  // `imap` is supplied, the new Supabase user + a mail_accounts row are
  // created together. The invite is only marked used once all of that has
  // succeeded — on failure the client may retry.
  app.post<{ Params: { token: string }; Body: AcceptBody }>(
    "/invites/:token/accept", async (req, reply) => {
      if (!supabaseAdmin) return reply.internalServerError("admin key not configured");
      const b = req.body || ({} as AcceptBody);
      if (!b.password || b.password.length < 8) return reply.badRequest("Password must be at least 8 characters");
      if (b.imap && (!b.imap.host || !b.imap.port || !b.imap.user || !b.imap.password)) {
        return reply.badRequest("Incomplete IMAP settings");
      }

      const pool = requirePool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query<{ email: string | null; expires_at: string | null; used_at: string | null }>(
          `SELECT email, expires_at, used_at FROM invites WHERE token = $1 FOR UPDATE`,
          [req.params.token],
        );
        if (r.rows.length === 0) { await client.query("ROLLBACK"); return reply.code(404).send({ ok:false, error:"Invite not found" }); }
        const inv = r.rows[0];
        if (inv.used_at) { await client.query("ROLLBACK"); return reply.code(410).send({ ok:false, error:"Invite already used" }); }
        if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
          await client.query("ROLLBACK");
          return reply.code(410).send({ ok:false, error:"Invite expired" });
        }
        if (!inv.email) { await client.query("ROLLBACK"); return reply.badRequest("Invite has no bound email"); }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: inv.email,
          password: b.password,
          email_confirm: true,
          user_metadata: b.display_name ? { display_name: b.display_name } : undefined,
        });
        if (error || !data.user) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ ok:false, error: error?.message || "Failed to create user" });
        }
        const userId = data.user.id;

        let mailAccountId: string | null = null;
        if (b.imap) {
          const imapEnc = encrypt(b.imap.password);
          const smtpEnc = encrypt(b.imap.password); // same creds unless user split them (rare)
          const smtpHost = b.imap.smtp_host || b.imap.host.replace(/^imap\./i, "smtp.");
          const smtpPort = b.imap.smtp_port || 465;
          try {
            const ins = await client.query<{ id: string }>(
              `INSERT INTO mail_accounts (
                 user_id, email, provider, display_name,
                 imap_host, imap_port, imap_user, imap_cred_enc,
                 smtp_host, smtp_port, smtp_user, smtp_cred_enc,
                 auto_sync
               ) VALUES ($1,$2,'generic',$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
               RETURNING id`,
              [
                userId, inv.email, b.display_name || null,
                b.imap.host, b.imap.port, b.imap.user, imapEnc,
                smtpHost, smtpPort, b.imap.user, smtpEnc,
              ],
            );
            mailAccountId = ins.rows[0]?.id || null;
          } catch (e) {
            await client.query("ROLLBACK");
            // User was created in Supabase but mail_accounts insert failed.
            // They can still sign in next time with their password and add
            // the account from Settings. Surface the error cleanly.
            return reply.code(500).send({
              ok: false,
              userCreated: true,
              error: `Account created but mail account save failed: ${(e as Error).message}. You can sign in and add it from Settings.`,
            });
          }
        }

        await client.query(
          `UPDATE invites SET used_by = $1, used_at = now() WHERE token = $2`,
          [userId, req.params.token],
        );
        await client.query("COMMIT");
        return { ok: true, email: inv.email, userId, mailAccountId };
      } catch (e) {
        await client.query("ROLLBACK");
        return reply.internalServerError((e as Error).message);
      } finally {
        client.release();
      }
    },
  );
}
