import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";
import { supabaseWithJwt } from "../supabase.js";

export async function registerContactsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Patch a contact (news/mute flags + archive) ─────────────────────────
  // Name/org/color/r2m_days land in Tier 1.9 — keeping this route narrow for
  // now so the per-contact News/Mute toggles and Archive can persist.
  app.patch<{
    Params: { id: string };
    Body: { is_news?: boolean; is_muted?: boolean; archived?: boolean };
  }>("/contacts/:id", auth, async (req, reply) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    if (typeof b.is_news  === "boolean") patch.is_news  = b.is_news;
    if (typeof b.is_muted === "boolean") patch.is_muted = b.is_muted;
    if (typeof b.archived === "boolean") patch.archived_at = b.archived ? new Date().toISOString() : null;
    if (Object.keys(patch).length === 0) return reply.badRequest("nothing to update");
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("contacts").update(patch).eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });

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

  // ─── Unmerge one email off a contact into a new contact ────────────────
  // Used when a contact was erroneously auto-merged or when a shared address
  // should become its own identity. Leaves the original contact with its
  // remaining emails. Messages re-attribute via email lookup on next sync.
  app.post<{ Params: { id: string }; Body: { email: string; name?: string } }>(
    "/contacts/:id/unmerge-email",
    auth,
    async (req, reply) => {
      const contactId = req.params.id;
      const email = (req.body?.email || "").toLowerCase().trim();
      const requestedName = req.body?.name?.trim();
      if (!email) return reply.badRequest("email required");

      const pool = requirePool();
      const userId = req.authUser!.id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Ownership + email-belongs-to-this-contact check
        const own = await client.query<{ user_id: string }>(
          `SELECT user_id FROM contacts WHERE id = $1 FOR UPDATE`,
          [contactId],
        );
        if (own.rows.length === 0) { await client.query("ROLLBACK"); return reply.notFound(); }
        if (own.rows[0].user_id !== userId) { await client.query("ROLLBACK"); return reply.forbidden(); }

        const ce = await client.query(
          `SELECT 1 FROM contact_emails WHERE contact_id = $1 AND email = $2`,
          [contactId, email],
        );
        if (ce.rowCount === 0) { await client.query("ROLLBACK"); return reply.badRequest("email not linked to this contact"); }

        const countRes = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM contact_emails WHERE contact_id = $1`,
          [contactId],
        );
        if (countRes.rows[0].c <= 1) { await client.query("ROLLBACK"); return reply.badRequest("contact has only one email — cannot unmerge"); }

        // Derive a reasonable default name from the local-part if none provided
        const defaultName = email.split("@")[0]
          .split(/[._-]+/).filter(Boolean)
          .map(p => p[0].toUpperCase() + p.slice(1)).join(" ")
          || email;
        const newName = requestedName || defaultName;

        const ins = await client.query<{ id: string }>(
          `INSERT INTO contacts (user_id, name, primary_email)
             VALUES ($1, $2, $3)
             RETURNING id`,
          [userId, newName, email],
        );
        const newId = ins.rows[0].id;

        await client.query(
          `UPDATE contact_emails SET contact_id = $1, user_id = $2 WHERE email = $3 AND contact_id = $4`,
          [newId, userId, email, contactId],
        );

        await client.query("COMMIT");
        return { ok: true, newContactId: newId, name: newName, email };
      } catch (e) {
        await client.query("ROLLBACK");
        const msg = e instanceof Error ? e.message : String(e);
        return reply.internalServerError(msg);
      } finally {
        client.release();
      }
    },
  );
}
