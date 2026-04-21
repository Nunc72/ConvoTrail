// PATCH /messages/:id/r2m — dismiss or snooze a revert-to-me timer.
// The initial arming happens at send time (see mailAccounts.ts's /send).
import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";
import { fibSnoozeDays } from "../r2m.js";

interface R2mBody {
  dismiss?: boolean;
  snooze?: boolean;
}

export async function registerR2mRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  app.patch<{ Params: { id: string }; Body: R2mBody }>(
    "/messages/:id/r2m", auth, async (req, reply) => {
      const b = req.body || {};
      if (!b.dismiss && !b.snooze) return reply.badRequest("dismiss or snooze required");

      const pool = requirePool();
      // Ownership check on the message
      const own = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM messages WHERE id = $1`, [req.params.id],
      );
      if (own.rows.length === 0) return reply.notFound();
      if (own.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

      if (b.dismiss) {
        await pool.query(
          `INSERT INTO r2m_state (message_id, user_id, dismissed_at)
             VALUES ($1, $2, now())
           ON CONFLICT (message_id) DO UPDATE SET dismissed_at = now()`,
          [req.params.id, req.authUser!.id],
        );
      }
      if (b.snooze) {
        // Fetch existing snooze_count (upserted below).
        const cur = await pool.query<{ snooze_count: number | null }>(
          `SELECT snooze_count FROM r2m_state WHERE message_id = $1`, [req.params.id],
        );
        const nextCount = (cur.rows[0]?.snooze_count ?? 0) + 1;
        const days = fibSnoozeDays(nextCount - 1); // count=1 → 3, count=2 → 5, …
        await pool.query(
          `INSERT INTO r2m_state (message_id, user_id, snooze_until, snooze_count)
             VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)
           ON CONFLICT (message_id) DO UPDATE
             SET snooze_until = now() + ($3 || ' days')::interval,
                 snooze_count = $4,
                 dismissed_at = NULL`,
          [req.params.id, req.authUser!.id, String(days), nextCount],
        );
      }

      const { rows } = await pool.query<{
        dismissed_at: string | null; snooze_until: string | null; snooze_count: number;
      }>(
        `SELECT dismissed_at, snooze_until, snooze_count
           FROM r2m_state WHERE message_id = $1`,
        [req.params.id],
      );
      return { ok: true, r2m: rows[0] || null };
    },
  );
}
