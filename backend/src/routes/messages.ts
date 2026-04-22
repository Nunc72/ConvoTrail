// Per-message actions: flag updates (seen/flagged/answered) mirrored to IMAP
// so the user's other mail clients see the same state. Also serves the full
// message body (with inline cid: images resolved to data URIs) and individual
// attachment downloads, both on-demand from IMAP.
import type { FastifyInstance } from "fastify";
import { ImapFlow } from "imapflow";
import { simpleParser, type Attachment } from "mailparser";
import { authPreHandler } from "../auth.js";
import { decrypt } from "../crypto.js";
import { requirePool } from "../db.js";

interface MessageImapRow {
  user_id: string;
  mail_account_id: string;
  folder: string;
  uid: number;
  imap_host: string | null;
  imap_port: number | null;
  imap_user: string | null;
  imap_cred_enc: Buffer | null;
}

// Fetch the full RFC822 source of a message from IMAP and run mailparser
// against it. Shared helper for both /body and /attachments/:index so we
// keep the IMAP-connection dance in one place.
async function fetchAndParse(row: MessageImapRow) {
  const client = new ImapFlow({
    host: row.imap_host!, port: row.imap_port!, secure: true,
    auth: { user: row.imap_user || "", pass: decrypt(row.imap_cred_enc!) },
    logger: false, socketTimeout: 30_000,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(row.folder);
    try {
      const msg = await client.fetchOne(String(row.uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error("message source not available");
      return await simpleParser(msg.source);
    } finally { lock.release(); }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

function stripAngleBrackets(s: string): string {
  return s.replace(/^<+|>+$/g, "");
}

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

  // ─── Full body with inline cid: resolution + attachment list ────────────
  // On-demand fetch from IMAP — we don't cache the source locally yet. The
  // attachments list includes both inline images and regular attachments;
  // the frontend filters the inline ones out of its "chip" view.
  app.get<{ Params: { id: string } }>(
    "/messages/:id/body", auth, async (req, reply) => {
      const pool = requirePool();
      const r = await pool.query<MessageImapRow>(
        `SELECT m.user_id, m.mail_account_id, m.folder, m.uid,
                a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
           FROM messages m
           JOIN mail_accounts a ON a.id = m.mail_account_id
          WHERE m.id = $1`,
        [req.params.id],
      );
      if (r.rows.length === 0) return reply.notFound();
      const row = r.rows[0];
      if (row.user_id !== req.authUser!.id) return reply.forbidden();
      if (!row.imap_host || !row.imap_port || !row.imap_cred_enc) {
        return reply.badRequest("IMAP not configured for this account");
      }

      let parsed;
      try {
        parsed = await fetchAndParse(row);
      } catch (e) {
        return reply.code(502).send({ ok: false, error: `IMAP fetch failed: ${(e as Error).message}` });
      }

      const attachments = parsed.attachments || [];
      const cidToDataUri = new Map<string, string>();
      const publicList = attachments.map((att: Attachment, index: number) => {
        const cidBare = att.cid ? stripAngleBrackets(att.cid) : null;
        if (cidBare && att.content) {
          // Inline image: encode once so the HTML can render without extra
          // round-trips. contentType defaults to octet-stream for safety.
          const type = att.contentType || "application/octet-stream";
          cidToDataUri.set(cidBare, `data:${type};base64,${att.content.toString("base64")}`);
        }
        return {
          index,
          filename: att.filename || `attachment-${index + 1}`,
          contentType: att.contentType || "application/octet-stream",
          size: att.size ?? att.content?.length ?? 0,
          isInline: !!cidBare,
          cid: cidBare,
        };
      });

      let html: string | null = typeof parsed.html === "string" ? parsed.html : null;
      if (html) {
        // Resolve both single- and double-quoted forms, plus cid references
        // without surrounding quotes. Also tolerate an optional leading '<'.
        html = html.replace(/cid:<?([^"'\s>]+?)>?(?=["'\s>])/gi, (m, cid) => {
          return cidToDataUri.get(stripAngleBrackets(cid)) || m;
        });
      }

      return {
        html,
        text: parsed.text || null,
        attachments: publicList,
      };
    },
  );

  // ─── Stream a single attachment (non-inline or inline, by index) ─────────
  app.get<{ Params: { id: string; index: string } }>(
    "/messages/:id/attachments/:index", auth, async (req, reply) => {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return reply.badRequest("invalid index");

      const pool = requirePool();
      const r = await pool.query<MessageImapRow>(
        `SELECT m.user_id, m.mail_account_id, m.folder, m.uid,
                a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
           FROM messages m
           JOIN mail_accounts a ON a.id = m.mail_account_id
          WHERE m.id = $1`,
        [req.params.id],
      );
      if (r.rows.length === 0) return reply.notFound();
      const row = r.rows[0];
      if (row.user_id !== req.authUser!.id) return reply.forbidden();
      if (!row.imap_host || !row.imap_port || !row.imap_cred_enc) {
        return reply.badRequest("IMAP not configured for this account");
      }

      let parsed;
      try {
        parsed = await fetchAndParse(row);
      } catch (e) {
        return reply.code(502).send({ ok: false, error: `IMAP fetch failed: ${(e as Error).message}` });
      }

      const att = parsed.attachments?.[index];
      if (!att || !att.content) return reply.notFound("attachment not found");

      const safeName = (att.filename || `attachment-${index + 1}`).replace(/"/g, "");
      reply
        .type(att.contentType || "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
        .header("Content-Length", String(att.content.length));
      return reply.send(att.content);
    },
  );

  // ─── Soft-delete: set deleted_at = now() ─────────────────────────────────
  // MVP: DB-only. IMAP is left untouched — the retention cron (Tier 2.5) will
  // EXPUNGE 90 days after deletion. Users can recover within that window.
  app.patch<{ Params: { id: string } }>("/messages/:id/delete", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM messages WHERE id = $1`, [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();
    await pool.query(
      `UPDATE messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    return reply.code(204).send();
  });

  // ─── Recover from Deleted (clear deleted_at) ─────────────────────────────
  app.patch<{ Params: { id: string } }>("/messages/:id/recover", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM messages WHERE id = $1`, [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();
    await pool.query(
      `UPDATE messages SET deleted_at = NULL WHERE id = $1`,
      [req.params.id],
    );
    return reply.code(204).send();
  });
}
