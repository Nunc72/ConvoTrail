// Username-related endpoints.
//   POST /auth/username-to-email (public): translate a free-format username
//     to the Supabase user's email so the frontend can call signInWithPassword
//     and resetPasswordForEmail. The username is stored in user_usernames
//     with a case-insensitive UNIQUE constraint.
//   PATCH /me/username (auth): change the signed-in user's username, with
//     a uniqueness check.
import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";
import { supabaseAdmin } from "../supabase.js";

const USERNAME_RE = /^[A-Za-z0-9._@+\-]{2,64}$/;

export async function registerUserAuthRoutes(app: FastifyInstance) {
  // Public lookup. Returns 404 if no match — same response shape on success
  // or failure so a probing attacker can't easily confirm an email exists
  // beyond what the email-based reset would already leak.
  app.post<{ Body: { username?: string } }>(
    "/auth/username-to-email",
    {
      // Tight per-IP cap because this endpoint is exposed unauthenticated
      // and would otherwise let an attacker enumerate valid usernames.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (!supabaseAdmin) return reply.internalServerError("admin key not configured");
      const u = (req.body?.username || "").trim();
      if (!u) return reply.code(400).send({ ok: false, error: "username required" });

      const pool = requirePool();
      const r = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM user_usernames WHERE LOWER(username) = LOWER($1)`,
        [u],
      );
      if (r.rows.length === 0) {
        req.log.info({ username: u }, "username-to-email: no user_usernames row");
        return reply.code(404).send({ ok: false });
      }
      const userId = r.rows[0].user_id;
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error || !data?.user?.email) {
        // Log the underlying failure so we can tell admin-API errors
        // apart from a genuinely missing user. Otherwise the FE just
        // sees a generic "no account" 404, which masks expired
        // service keys, h2 stalls, etc. (Rik hit this with his own
        // RikTuithof account: row existed, admin lookup failed
        // silently, FE said "no account".)
        req.log.warn({
          username: u, userId,
          err: error ? { message: error.message, status: (error as { status?: number }).status, name: (error as { name?: string }).name } : null,
          hasUser: !!data?.user,
          hasEmail: !!data?.user?.email,
        }, "username-to-email: admin.getUserById failed");
        return reply.code(404).send({ ok: false });
      }
      return { ok: true, email: data.user.email };
    },
  );

  // Authenticated update. Validates format, then enforces uniqueness via the
  // table's UNIQUE index — we catch the constraint violation and turn it
  // into a clean 409 for the UI.
  app.patch<{ Body: { username?: string } }>(
    "/me/username", { preHandler: authPreHandler }, async (req, reply) => {
      const u = (req.body?.username || "").trim();
      if (!USERNAME_RE.test(u)) {
        return reply.badRequest("Username must be 2-64 chars (letters, digits, . _ @ + -)");
      }
      const pool = requirePool();
      try {
        await pool.query(
          `INSERT INTO user_usernames (user_id, username, updated_at)
             VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
             SET username = EXCLUDED.username, updated_at = now()`,
          [req.authUser!.id, u],
        );
      } catch (e: unknown) {
        // 23505 = unique_violation
        const code = (e as { code?: string })?.code;
        if (code === "23505") {
          return reply.code(409).send({ ok: false, error: "Username is already taken" });
        }
        throw e;
      }
      return { ok: true, username: u };
    },
  );
}
