import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";
import { supabaseWithJwt } from "../supabase.js";
import { parseUserKeyHeader, encryptForUser } from "../userCrypto.js";

export async function registerContactsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Patch a contact ─────────────────────────────────────────────────────
  // Partial update. Nullish values clear the field where applicable
  // (org/color → null; name cannot be blanked). primary_email must match one
  // of the contact_emails rows to be accepted.
  app.patch<{
    Params: { id: string };
    Body: {
      is_news?: boolean; is_no_reply?: boolean; is_muted?: boolean;
      mute_reason?: string | null;
      archived?: boolean;
      name?: string; org?: string | null; color?: string | null;
      r2m_days?: number; primary_email?: string;
    };
  }>("/contacts/:id", auth, async (req, reply) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    if (typeof b.is_news    === "boolean")  {
      patch.is_news  = b.is_news;
      // The user explicitly touched News (either direction). From now on
      // the sync's auto-tag-newsletter logic must not flip it back.
      patch.is_news_user_set = true;
    }
    if (typeof b.is_no_reply === "boolean") {
      patch.is_no_reply = b.is_no_reply;
      // Mirror of is_news_user_set: once the user has explicitly toggled
      // Noreply (either direction), the sync's auto-tag-noreply logic
      // must not flip it back on the next pass.
      patch.is_no_reply_user_set = true;
    }
    if (typeof b.is_muted    === "boolean") {
      patch.is_muted = b.is_muted;
      // Clear the reason on un-mute so the next mute (e.g. manual) doesn't
      // inherit a stale "spam" tag.
      if (b.is_muted === false) patch.mute_reason = null;
    }
    if (b.mute_reason !== undefined) {
      patch.mute_reason = (typeof b.mute_reason === "string" && b.mute_reason.trim())
        ? b.mute_reason.trim() : null;
    }
    if (typeof b.archived === "boolean")  patch.archived_at = b.archived ? new Date().toISOString() : null;
    if (typeof b.name     === "string" && b.name.trim()) patch.name = b.name.trim();
    if (b.org   !== undefined)            patch.org   = (typeof b.org   === "string" && b.org.trim())   ? b.org.trim()   : null;
    if (b.color !== undefined)            patch.color = (typeof b.color === "string" && b.color.trim()) ? b.color.trim() : null;
    if (typeof b.r2m_days === "number" && Number.isFinite(b.r2m_days)) patch.r2m_days = Math.max(0, Math.min(30, Math.round(b.r2m_days)));
    if (Object.keys(patch).length === 0 && !b.primary_email) return reply.badRequest("nothing to update");

    const sb = supabaseWithJwt(req.authJwt!);
    if (Object.keys(patch).length > 0) {
      const { error } = await sb.from("contacts").update(patch).eq("id", req.params.id);
      if (error) return reply.internalServerError(error.message);
    }

    // Phase 1.5b — keep _enc twins in sync. Done as a separate pg-pool
    // UPDATE because supabase-js mangles Node Buffers. v0.0.254.
    const userKey = parseUserKeyHeader(req.headers["x-user-key"]);
    if (userKey && (typeof b.name === "string" || b.org !== undefined)) {
      const pool = requirePool();
      const setParts: string[] = [];
      const vals: unknown[] = [];
      if (typeof b.name === "string" && b.name.trim()) {
        const enc = await encryptForUser(b.name.trim(), userKey);
        vals.push(enc);
        setParts.push(`name_enc = $${vals.length}`);
      }
      if (b.org !== undefined) {
        const orgVal = (typeof b.org === "string" && b.org.trim()) ? b.org.trim() : null;
        const enc = await encryptForUser(orgVal, userKey);
        vals.push(enc);
        setParts.push(`org_enc = $${vals.length}`);
      }
      if (setParts.length > 0) {
        vals.push(req.params.id);
        await pool.query(
          `UPDATE contacts SET ${setParts.join(", ")} WHERE id = $${vals.length}`,
          vals,
        );
      }
    }

    // primary_email is validated against contact_emails before being stored.
    if (typeof b.primary_email === "string" && b.primary_email.trim()) {
      const wanted = b.primary_email.trim().toLowerCase();
      const { data: rows, error: selErr } = await sb
        .from("contact_emails")
        .select("email")
        .eq("contact_id", req.params.id);
      if (selErr) return reply.internalServerError(selErr.message);
      const emails = (rows || []).map(r => (r.email as string).toLowerCase());
      if (!emails.includes(wanted)) return reply.badRequest("primary_email is not linked to this contact");
      const { error: updErr } = await sb.from("contacts").update({ primary_email: wanted }).eq("id", req.params.id);
      if (updErr) return reply.internalServerError(updErr.message);
    }

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

  // ─── Soft-delete contact + cascade-soft-delete their mail ───────────────
  // Rik's item 3: clicking "Delete" on a contact archives them with a
  // Deleted chip in the FE LeftColumn, and every mail attributed to
  // them is marked deleted_at so it appears in the contact's Deleted
  // tab. Single transaction:
  //   1. contacts.deleted_at = now() (the chip in the FE reads this)
  //   2. messages.deleted_at = now() for every mail whose from_email
  //      OR to_emails entry matches one of the contact's contact_emails.
  //      A mail shared with other contacts also gets the soft-delete
  //      flag — by design, the user is saying "remove this thread of
  //      mail from my workflow", and the global soft-delete is the
  //      simplest way to mirror that across IMAP-trash later.
  // The mail's IMAP folder is NOT moved here — the user explicitly
  // wanted that to happen only when the Gmail Trash itself empties
  // out 30 days later (or whenever the user manually trashes the
  // mails in their Gmail UI). Our existing permanent-delete detection
  // in sync.ts + cleanupOrphanContacts will then hard-delete the
  // contact when its last mail row disappears.
  app.delete<{ Params: { id: string } }>("/contacts/:id", auth, async (req, reply) => {
    const pool = requirePool();
    const userId = req.authUser!.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owns = await client.query<{ user_id: string; deleted_at: Date | null }>(
        `SELECT user_id, deleted_at FROM contacts WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      if (owns.rows.length === 0) { await client.query("ROLLBACK"); return reply.notFound(); }
      if (owns.rows[0].user_id !== userId) { await client.query("ROLLBACK"); return reply.forbidden(); }
      // 1. Mark the contact as deleted.
      await client.query(
        `UPDATE contacts SET deleted_at = now() WHERE id = $1`,
        [req.params.id],
      );
      // 2. Cascade-soft-delete the attributed mails. Skip ones that are
      //    already deleted_at so a repeat-delete doesn't overwrite the
      //    original timestamp.
      const cascade = await client.query<{ id: string }>(
        `UPDATE messages m
            SET deleted_at = now()
          WHERE m.user_id = $1
            AND m.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM contact_emails ce
               WHERE ce.contact_id = $2
                 AND (
                   LOWER(m.from_email) = LOWER(ce.email)
                   OR EXISTS (
                     SELECT 1 FROM jsonb_array_elements(COALESCE(m.to_emails, '[]'::jsonb)) te
                      WHERE LOWER(te->>'email') = LOWER(ce.email)
                   )
                 )
            )
        RETURNING id`,
        [userId, req.params.id],
      );
      await client.query("COMMIT");
      return { ok: true, cascadedMessageIds: cascade.rows.map(r => r.id) };
    } catch (e) {
      await client.query("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      return reply.internalServerError(msg);
    } finally {
      client.release();
    }
  });
}
