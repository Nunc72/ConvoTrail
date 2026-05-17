// Per-message actions: flag updates (seen/flagged/answered) mirrored to IMAP
// so the user's other mail clients see the same state. Also serves the full
// message body (with inline cid: images resolved to data URIs) and individual
// attachment downloads, both on-demand from IMAP.
import type { FastifyInstance } from "fastify";
import { ImapFlow } from "imapflow";
import { simpleParser, type Attachment } from "mailparser";
import { authPreHandler } from "../auth.js";
import { logAudit } from "../audit.js";
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

      // Update DB first — that's what the UI reads from on next bootstrap, so
      // a Seen click should always stick locally. Then mirror to IMAP best
      // effort: a transient IMAP failure (timeout, server reject) used to
      // make us return 502 and roll back the optimistic flip, which the user
      // experienced as the alert "coming back" after Seen. The next sync
      // pass will reconcile if IMAP and DB drift.
      const newFlags: Record<string, unknown> = { ...(m.flags || {}) };
      if (b.seen !== undefined)      newFlags.seen = b.seen;
      if (b.flagged !== undefined)   newFlags.flagged = b.flagged;
      if (b.answered !== undefined)  newFlags.answered = b.answered;
      await pool.query(
        `UPDATE messages SET flags = $1::jsonb WHERE id = $2`,
        [JSON.stringify(newFlags), id],
      );

      let imapWarning: string | null = null;
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
        imapWarning = "IMAP flag update failed (DB updated): " + (e instanceof Error ? e.message : String(e));
        req.log.warn({ err: e, messageId: id }, "flags: IMAP mirror failed; DB-only update");
      }

      return { ok: true, flags: newFlags, imapWarning };
    },
  );

  // ─── Full body with inline cid: resolution + attachment list ────────────
  // Cached in Postgres after the first IMAP round-trip. Subsequent /body
  // calls for the same message return from pg in <50 ms instead of the
  // 600-1500 ms it costs to spin up an IMAP connection, SELECT a mailbox,
  // and UID FETCH the source every time. The cache is invalidated when
  // sync overwrites the row (e.g. the mailbox replaced the message), at
  // which point the next /body call re-IMAPs and re-caches.
  interface AttMeta {
    index: number;
    filename: string;
    contentType: string;
    size: number;
    isInline: boolean;
    cid: string | null;
  }
  app.get<{ Params: { id: string } }>(
    "/messages/:id/body", auth, async (req, reply) => {
      const pool = requirePool();
      const r = await pool.query<MessageImapRow & {
        body_text: string | null;
        body_html: string | null;
        attachments_meta: AttMeta[] | null;
      }>(
        `SELECT m.user_id, m.mail_account_id, m.folder, m.uid,
                m.body_text, m.body_html, m.attachments_meta,
                a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
           FROM messages m
           JOIN mail_accounts a ON a.id = m.mail_account_id
          WHERE m.id = $1`,
        [req.params.id],
      );
      if (r.rows.length === 0) return reply.notFound();
      const row = r.rows[0];
      if (row.user_id !== req.authUser!.id) return reply.forbidden();

      // Cache hit: we already have both body and attachments-meta. The
      // FE only needs /body for the attachments list when bodies were
      // cached without it, so we still serve a hit when attachments_meta
      // is present even with NULL bodies (rare: pure-binary mail).
      if (row.attachments_meta !== null && (row.body_text !== null || row.body_html !== null)) {
        return {
          html: row.body_html,
          text: row.body_text,
          attachments: row.attachments_meta,
        };
      }

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
      // Pass 1: build the cid → data-uri map so the HTML rewrite below can
      // inline images. We do this for every attachment that carries a
      // Content-ID, regardless of disposition — the cid might still be
      // referenced in HTML even if the disposition is "attachment".
      const cidToDataUri = new Map<string, string>();
      for (const att of attachments as Attachment[]) {
        const cidBare = att.cid ? stripAngleBrackets(att.cid) : null;
        if (cidBare && att.content) {
          const type = att.contentType || "application/octet-stream";
          cidToDataUri.set(cidBare, `data:${type};base64,${att.content.toString("base64")}`);
        }
      }

      // Pass 2: rewrite the HTML and remember which cids were actually
      // consumed by an <img src="cid:..."> reference. Only those are truly
      // inline (visible in the body, no need to list separately). Anything
      // else — including attachments that happen to have a Content-ID but
      // aren't referenced in the markup — gets shown as a downloadable
      // attachment. This fixes the old behaviour where a Content-ID alone
      // hid the attachment from the user, which is how some mail clients
      // stamp every attachment.
      const usedCids = new Set<string>();
      let html: string | null = typeof parsed.html === "string" ? parsed.html : null;
      if (html) {
        html = html.replace(/cid:<?([^"'\s>]+?)>?(?=["'\s>])/gi, (m, cid) => {
          const bare = stripAngleBrackets(cid);
          const replacement = cidToDataUri.get(bare);
          if (replacement) usedCids.add(bare);
          return replacement || m;
        });
      }

      // Pass 3: build the public attachment list. isInline now requires
      // both a cid AND that cid being actually consumed by the HTML, so
      // a misclassification can no longer make a real attachment vanish.
      const publicList = attachments.map((att: Attachment, index: number) => {
        const cidBare = att.cid ? stripAngleBrackets(att.cid) : null;
        return {
          index,
          filename: att.filename || `attachment-${index + 1}`,
          contentType: att.contentType || "application/octet-stream",
          size: att.size ?? att.content?.length ?? 0,
          isInline: !!cidBare && usedCids.has(cidBare),
          cid: cidBare,
        };
      });

      // Write the parsed result back to messages so the next /body
      // call returns instantly from pg. Failure here is non-fatal — we
      // still served the user's current request, only the next one
      // would re-IMAP. Don't block on the write either.
      const textForCache = parsed.text || null;
      pool.query(
        `UPDATE messages
            SET body_text = $1,
                body_html = $2,
                attachments_meta = $3
          WHERE id = $4`,
        [textForCache, html, JSON.stringify(publicList), req.params.id],
      ).catch(e => req.log.warn({ err: e }, "/body cache write failed (non-fatal)"));

      return {
        html,
        text: textForCache,
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

  // ─── Unsubscribe (server-side POST, RFC 8058 One-Click) ─────────────────
  // The browser can't always POST cross-origin to a sender's unsubscribe
  // URL (CORS, mixed-content), so we proxy the request server-side. The
  // body the spec calls for is "List-Unsubscribe=One-Click", sent with
  // Content-Type: application/x-www-form-urlencoded.
  //
  // Falls back to "open URL" for non-one-click senders — the client can
  // detect that case from message.unsubscribe_one_click and use the URL
  // directly instead of hitting this endpoint.
  app.post<{ Params: { id: string } }>("/messages/:id/unsubscribe", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{
      user_id: string;
      unsubscribe_url: string | null;
      unsubscribe_one_click: boolean;
    }>(
      `SELECT user_id, unsubscribe_url, unsubscribe_one_click FROM messages WHERE id = $1`,
      [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    const row = r.rows[0];
    if (row.user_id !== req.authUser!.id) return reply.forbidden();
    if (!row.unsubscribe_url) return reply.badRequest("No unsubscribe URL");
    if (!row.unsubscribe_one_click) return reply.badRequest("Not a one-click sender");
    // RFC 8058: POST with body "List-Unsubscribe=One-Click".
    try {
      const res = await fetch(row.unsubscribe_url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      if (!res.ok && res.status !== 202) {
        return reply.internalServerError(`Unsubscribe POST returned ${res.status}`);
      }
      logAudit(req, "message.unsubscribe", { type: "message", id: req.params.id }, {
        url: row.unsubscribe_url, one_click: true,
      });
      return reply.code(204).send();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.internalServerError(`Unsubscribe POST failed: ${msg}`);
    }
  });
}
