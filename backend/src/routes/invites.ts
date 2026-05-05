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
  // Required when the invite has no bound email (modern code-based flow);
  // ignored when the invite was created with a pre-bound email.
  email?: string;
  // Free-format login identifier, decoupled from the email. Stored in
  // user_usernames with a case-insensitive UNIQUE constraint.
  username?: string;
  // Optional secondary contact info, persisted to user_metadata so the
  // Profile screen can edit them later.
  recovery_email?: string;
  mobile?: string;
  imap?: {
    host: string;
    port: number;
    user: string;
    password: string;
    smtp_host?: string;
    smtp_port?: number;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9._@+\-]{2,64}$/;

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
      const username = (b.username || "").trim();
      if (!username || !USERNAME_RE.test(username)) {
        return reply.badRequest("Username must be 2-64 chars (letters, digits, . _ @ + -)");
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
        // Resolve the email: pre-bound on the invite row wins; otherwise the
        // tester supplies one in the accept body (modern code-based flow).
        let email = inv.email;
        if (!email) {
          const supplied = (b.email || "").trim().toLowerCase();
          if (!supplied || !EMAIL_RE.test(supplied)) {
            await client.query("ROLLBACK");
            return reply.badRequest("Valid email required");
          }
          email = supplied;
        }

        // Pre-flight uniqueness check on the username — it's marginally
        // racy (someone could grab the same username between this check
        // and the INSERT below) but the UNIQUE index will catch the loser
        // and we'll surface a clean error.
        const uPre = await client.query<{ user_id: string }>(
          `SELECT user_id FROM user_usernames WHERE LOWER(username) = LOWER($1)`,
          [username],
        );
        if (uPre.rows.length > 0) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ ok:false, error: "Username is already taken" });
        }

        const metadata: Record<string, unknown> = {};
        if (b.display_name) metadata.display_name = b.display_name;
        if (b.recovery_email) metadata.recovery_email = b.recovery_email;
        if (b.mobile) metadata.mobile = b.mobile;
        metadata.username = username; // mirror so the Profile UI sees it without an extra fetch

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: b.password,
          email_confirm: true,
          user_metadata: Object.keys(metadata).length ? metadata : undefined,
        });
        if (error || !data.user) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ ok:false, error: error?.message || "Failed to create user" });
        }
        const userId = data.user.id;

        // Persist the username with the UNIQUE constraint. On a race-loss
        // we leave the Supabase user in place; the tester can sign in and
        // pick a new username from Settings. Same trade-off as the IMAP
        // failure path below.
        try {
          await client.query(
            `INSERT INTO user_usernames (user_id, username) VALUES ($1, $2)`,
            [userId, username],
          );
        } catch (e: unknown) {
          await client.query("ROLLBACK");
          const code = (e as { code?: string })?.code;
          if (code === "23505") {
            return reply.code(409).send({
              ok: false, userCreated: true,
              error: "Username was just claimed by someone else. Sign in and pick a new one from Settings.",
            });
          }
          throw e;
        }

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
                userId, email, b.display_name || null,
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
        return { ok: true, email, userId, mailAccountId };
      } catch (e) {
        await client.query("ROLLBACK");
        return reply.internalServerError((e as Error).message);
      } finally {
        client.release();
      }
    },
  );
}
