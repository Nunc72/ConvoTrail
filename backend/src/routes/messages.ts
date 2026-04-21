// Per-message actions: flag updates (seen/flagged/answered) mirrored to IMAP
// so the user's other mail clients see the same state.
import type { FastifyInstance } from "fastify";
import { ImapFlow } from "imapflow";
import { authPreHandler } from "../auth.js";
import { decrypt } from "../crypto.js";
import { requirePool } from "../db.js";

interface FlagsBody {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}

export async function registerMessagesRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Update message flags (mirrored to IMAP) ─────────────────────────────
  app.patch<{ Params: { id: string }; Body: FlagsBody }>(
    "/messages/:id/flags", auth, async (req, reply) => {
      const { id } = req.params;
      const b = req.body || {};
      if (b.seen === undefined && b.flagged === undefined && b.answered === undefined) {
        return reply.badRequest("no flags to update");
      }

      const pool = requirePool();
      const r = await pool.query<{
        user_id: string;
        mail_account_id: string;
        folder: string;
        uid: number;
        flags: Record<string, unknown> | null;
        imap_host: string | null;
        imap_port: number | null;
        imap_user: string | null;
        imap_cred_enc: Buffer | null;
      }>(
        `SELECT m.user_id, m.mail_account_id, m.folder, m.uid, m.flags,
                a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
           FROM messages m
           JOIN mail_accounts a ON a.id = m.mail_account_id
          WHERE m.id = $1`,
        [id],
      );
      if (r.rows.length === 0) return reply.notFound();
      const m = r.rows[0];
      if (m.user_id !== req.authUser!.id) return reply.forbidden();
      if (!m.imap_host || !m.imap_port || !m.imap_cred_enc) {
        return reply.badRequest("IMAP not configured for this account");
      }

      const toAdd: string[] = [];
      const toRm: string[] = [];
      if (b.seen === true)       toAdd.push("\\Seen");
      if (b.seen === false)      toRm.push("\\Seen");
      if (b.flagged === true)    toAdd.push("\\Flagged");
      if (b.flagged === false)   toRm.push("\\Flagged");
      if (b.answered === true)   toAdd.push("\\Answered");
      if (b.answered === false)  toRm.push("\\Answered");

      // Mirror to IMAP first. If the server rejects the change we don't touch
      // the DB, so the UI-revert leaves us consistent with the mail provider.
      const client = new ImapFlow({
        host: m.imap_host, port: m.imap_port, secure: true,
        auth: { user: m.imap_user || "", pass: decrypt(m.imap_cred_enc) },
        logger: false, socketTimeout: 15_000,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(m.folder);
        try {
          const uidStr = String(m.uid);
          if (toAdd.length) await client.messageFlagsAdd(uidStr, toAdd, { uid: true });
          if (toRm.length)  await client.messageFlagsRemove(uidStr, toRm, { uid: true });
        } finally { lock.release(); }
        await client.logout();
      } catch (e) {
        try { await client.logout(); } catch { /* ignore */ }
        return reply.code(502).send({
          ok: false,
          error: "IMAP flag update failed: " + (e instanceof Error ? e.message : String(e)),
        });
      }

      // Now update our cached flags JSONB.
      const newFlags: Record<string, unknown> = { ...(m.flags || {}) };
      if (b.seen !== undefined)      newFlags.seen = b.seen;
      if (b.flagged !== undefined)   newFlags.flagged = b.flagged;
      if (b.answered !== undefined)  newFlags.answered = b.answered;
      await pool.query(
        `UPDATE messages SET flags = $1::jsonb WHERE id = $2`,
        [JSON.stringify(newFlags), id],
      );

      return { ok: true, flags: newFlags };
    },
  );
}
