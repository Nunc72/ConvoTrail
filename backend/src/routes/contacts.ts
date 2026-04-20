import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";

export async function registerContactsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Merge two contacts ────────────────────────────────────────────────
  // Moves contact_emails + contact_tags from discard → keep, then deletes
  // the discard contact. Idempotent on re-run (emails/tags already moved
  // are silently skipped). Messages resolve their contact via email lookup
  // on the frontend, so after merge they all attribute to the kept contact.
  app.post<{ Params: { id: string }; Body: { discardId: string } }>(
    "/contacts/:id/merge",
    auth,
    async (req, reply) => {
      const keepId = req.params.id;
      const discardId = req.body?.discardId;
      if (!discardId) return reply.badRequest("discardId required");
      if (keepId === discardId) return reply.badRequest("keep and discard must differ");

      const pool = requirePool();
      const userId = req.authUser!.id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Ownership check for both rows
        const owns = await client.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM contacts WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [[keepId, discardId]],
        );
        if (owns.rows.length !== 2) { await client.query("ROLLBACK"); return reply.notFound(); }
        if (owns.rows.some(r => r.user_id !== userId)) { await client.query("ROLLBACK"); return reply.forbidden(); }

        // Move contact_emails — drop collisions first, then reassign remaining
        await client.query(
          `DELETE FROM contact_emails
             WHERE contact_id = $1
               AND email IN (SELECT email FROM contact_emails WHERE contact_id = $2)`,
          [discardId, keepId],
        );
        await client.query(
          `UPDATE contact_emails SET contact_id = $2 WHERE contact_id = $1`,
          [discardId, keepId],
        );

        // Move contact_tags similarly
        await client.query(
          `DELETE FROM contact_tags
             WHERE contact_id = $1
               AND tag_id IN (SELECT tag_id FROM contact_tags WHERE contact_id = $2)`,
          [discardId, keepId],
        );
        await client.query(
          `UPDATE contact_tags SET contact_id = $2 WHERE contact_id = $1`,
          [discardId, keepId],
        );

        // Drop the discarded contact
        await client.query(`DELETE FROM contacts WHERE id = $1`, [discardId]);

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        const msg = e instanceof Error ? e.message : String(e);
        return reply.internalServerError(msg);
      } finally {
        client.release();
      }

      return { ok: true, kept: keepId, discarded: discardId };
    },
  );
}
