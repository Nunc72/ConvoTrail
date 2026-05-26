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
import { parseUserKeyHeader, encryptForUser } from "../userCrypto.js";
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

      // v0.0.236: try up to MAX_ATTEMPTS times to mirror flags to IMAP.
      // Earlier versions tried just once — silent failures (Oxilion
      // hick-ups, transient socket timeouts) left DB and IMAP in drift,
      // visible after months as a big stack of mails marked seen in
      // Convooz but still unread on the mailserver. Sync reconciliation
      // catches the slow path; this retry loop catches the fast one.
      let imapWarning: string | null = null;
      const MAX_ATTEMPTS = 10;
      const uidStr = String(m.uid);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const client = new ImapFlow({
          host: m.imap_host, port: m.imap_port, secure: true,
          auth: { user: m.imap_user || "", pass: decrypt(m.imap_cred_enc) },
          logger: false, socketTimeout: 15_000,
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock(m.folder);
          try {
            if (toAdd.length) await client.messageFlagsAdd(uidStr, toAdd, { uid: true });
            if (toRm.length)  await client.messageFlagsRemove(uidStr, toRm, { uid: true });
          } finally { lock.release(); }
          await client.logout();
          imapWarning = null;
          break; // success
        } catch (e) {
          try { await client.logout(); } catch { /* ignore */ }
          if (attempt === MAX_ATTEMPTS) {
            imapWarning = `IMAP flag update failed after ${MAX_ATTEMPTS} attempts: ${e instanceof Error ? e.message : String(e)}`;
            req.log.warn({ err: e, messageId: id, attempts: MAX_ATTEMPTS }, "flags: IMAP mirror exhausted retries");
          } else {
            req.log.warn({ err: e, messageId: id, attempt }, "flags: IMAP mirror attempt failed, retrying");
            await new Promise(r => setTimeout(r, 500));
          }
        }
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
        body_text_enc: Buffer | null;
        body_html_enc: Buffer | null;
        attachments_meta: AttMeta[] | null;
      }>(
        `SELECT m.user_id, m.mail_account_id, m.folder, m.uid,
                m.body_text, m.body_html, m.body_text_enc, m.body_html_enc,
                m.attachments_meta,
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
      // v0.0.247: also ship body_text_enc / body_html_enc as base64 so
      // the FE can decrypt client-side when unlocked. Plaintext stays
      // as the fallback for locked sessions.
      if (row.attachments_meta !== null && (row.body_text !== null || row.body_html !== null)) {
        return {
          html: row.body_html,
          text: row.body_text,
          body_text_enc: row.body_text_enc ? row.body_text_enc.toString("base64") : null,
          body_html_enc: row.body_html_enc ? row.body_html_enc.toString("base64") : null,
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
      // v0.0.247: also write body_text_enc + body_html_enc when the user
      // is unlocked (X-User-Key present). COALESCE keeps existing _enc
      // values if this request happens to be locked — never blow away a
      // previously-encrypted blob with NULL.
      const textForCache = parsed.text || null;
      const userKey = parseUserKeyHeader(req.headers["x-user-key"]);
      let bodyTextEnc: Buffer | null = null;
      let bodyHtmlEnc: Buffer | null = null;
      if (userKey) {
        [bodyTextEnc, bodyHtmlEnc] = await Promise.all([
          encryptForUser(textForCache, userKey),
          encryptForUser(html, userKey),
        ]);
      }
      pool.query(
        `UPDATE messages
            SET body_text = $1,
                body_html = $2,
                attachments_meta = $3,
                body_text_enc = COALESCE($4, body_text_enc),
                body_html_enc = COALESCE($5, body_html_enc)
          WHERE id = $6`,
        [textForCache, html, JSON.stringify(publicList), bodyTextEnc, bodyHtmlEnc, req.params.id],
      ).catch(e => req.log.warn({ err: e }, "/body cache write failed (non-fatal)"));

      return {
        html,
        text: textForCache,
        body_text_enc: bodyTextEnc ? bodyTextEnc.toString("base64") : null,
        body_html_enc: bodyHtmlEnc ? bodyHtmlEnc.toString("base64") : null,
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

  // ─── Delete: move to IMAP Trash + soft-delete in DB ──────────────────────
  // Two-way Trash sync per Rik's request: hitting Delete in Convooz should
  // also land the mail in Gmail's (or any IMAP server's) Trash folder so
  // the two stay in sync. The reverse direction — mails the user trashed
  // elsewhere — comes in via the sync.ts Trash-folder pass.
  //
  // IMAP first, DB after: if the move succeeds we write the new folder
  // path + UID + deleted_at in one shot; if it fails (no \Trash special-
  // use, transient network, etc.) we fall back to a DB-only soft-delete
  // and let the next sync's permanent-delete detection reconcile.
  app.patch<{ Params: { id: string } }>("/messages/:id/delete", auth, async (req, reply) => {
    const pool = requirePool();
    const userId = req.authUser!.id;
    const r = await pool.query<{
      user_id: string;
      mail_account_id: string;
      folder: string;
      uid: number;
      deleted_at: Date | null;
      imap_host: string | null;
      imap_port: number | null;
      imap_user: string | null;
      imap_cred_enc: Buffer | null;
    }>(
      `SELECT m.user_id, m.mail_account_id, m.folder, m.uid, m.deleted_at,
              a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
         FROM messages m
         JOIN mail_accounts a ON a.id = m.mail_account_id
        WHERE m.id = $1`,
      [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    const m = r.rows[0];
    if (m.user_id !== userId) return reply.forbidden();
    if (m.deleted_at) return reply.code(204).send();

    let newFolder = m.folder;
    let newUid = m.uid;
    let imapMoved = false;
    if (m.imap_host && m.imap_port && m.imap_cred_enc) {
      const client = new ImapFlow({
        host: m.imap_host, port: m.imap_port, secure: true,
        auth: { user: m.imap_user || "", pass: decrypt(m.imap_cred_enc) },
        logger: false, socketTimeout: 20_000,
      });
      try {
        await client.connect();
        const mailboxes = await client.list();
        const trash = mailboxes.find(mb => mb.specialUse === "\\Trash");
        // Skip the move if the message is already in Trash (idempotent
        // retry / a Trash-row delete re-click). DB still gets touched
        // below to refresh deleted_at.
        if (trash && m.folder !== trash.path) {
          const lock = await client.getMailboxLock(m.folder);
          try {
            const moveRes = await client.messageMove(String(m.uid), trash.path, { uid: true });
            const destUid = moveRes && (moveRes as { uidMap?: Map<number, number> }).uidMap?.get(m.uid);
            if (destUid) {
              newFolder = trash.path;
              newUid = destUid;
              imapMoved = true;
            }
          } finally { lock.release(); }
        }
        await client.logout();
      } catch (e) {
        try { await client.logout(); } catch { /* ignore */ }
        req.log.warn({ err: e, messageId: req.params.id }, "delete: IMAP move-to-trash failed; DB-only soft delete");
      }
    }

    if (imapMoved) {
      await pool.query(
        `UPDATE messages SET deleted_at = now(), folder = $1, uid = $2 WHERE id = $3`,
        [newFolder, newUid, req.params.id],
      );
    } else {
      await pool.query(
        `UPDATE messages SET deleted_at = now() WHERE id = $1`,
        [req.params.id],
      );
    }
    return reply.code(204).send();
  });

  // ─── Soft-delete-as-spam: deleted_at + spam=true + mute the contact ──────
  // Reporting a mail as spam should also stop future mail from the same
  // contact from cluttering the main feed. We:
  //   1. flag the message: deleted_at + spam=true (the FE renders a "Spam"
  //      label in the deleted list to distinguish from a plain delete),
  //   2. find the contact tied to the sender's email, and
  //   3. set that contact's is_muted = true + mute_reason = 'spam' so the
  //      Muted tab shows it (with a "Spam" chip in the row).
  // The contact step is best-effort: if no contact owns this from_email
  // we leave the mail flagged and move on. RLS is enforced via user_id
  // checks at both layers.
  app.patch<{ Params: { id: string } }>("/messages/:id/spam", auth, async (req, reply) => {
    const pool = requirePool();
    const userId = req.authUser!.id;
    const r = await pool.query<{ user_id: string; from_email: string | null }>(
      `SELECT user_id, from_email FROM messages WHERE id = $1`,
      [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== userId) return reply.forbidden();
    const fromEmail = (r.rows[0].from_email || '').toLowerCase();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE messages
            SET deleted_at = COALESCE(deleted_at, now()),
                spam = TRUE
          WHERE id = $1`,
        [req.params.id],
      );
      // Mute the contact whose email this mail came from (only for
      // incoming mail — outgoing-as-spam doesn't make sense, but the
      // check is cheap).
      if (fromEmail) {
        await client.query(
          `UPDATE contacts c
              SET is_muted = TRUE,
                  mute_reason = 'spam'
            WHERE c.user_id = $1
              AND EXISTS (
                SELECT 1 FROM contact_emails ce
                 WHERE ce.contact_id = c.id AND LOWER(ce.email) = $2
              )`,
          [userId, fromEmail],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      return reply.internalServerError(msg);
    } finally {
      client.release();
    }
    return reply.code(204).send();
  });

  // ─── Recover: move out of IMAP Trash + clear deleted_at ─────────────────
  // Destination depends on the message direction so we mirror what Gmail
  // does natively: an incoming mail goes back to INBOX (the user expects
  // to find it where new mail lands), an outgoing mail goes back to Sent
  // (a sent mail in INBOX would feel wrong). On Gmail, MOVE into INBOX
  // /Sent reattaches the \Inbox / \Sent label and the mail re-enters
  // All Mail at a brand-new UID; we look that up via Message-ID so the
  // DB row points at a fetchable All Mail UID after recover (our
  // primary sync target). Non-Gmail servers (no \All) keep the row at
  // the destination folder directly.
  app.patch<{ Params: { id: string } }>("/messages/:id/recover", auth, async (req, reply) => {
    const pool = requirePool();
    const userId = req.authUser!.id;
    const r = await pool.query<{
      user_id: string;
      mail_account_id: string;
      folder: string;
      uid: number;
      direction: string;
      message_id: string | null;
      imap_host: string | null;
      imap_port: number | null;
      imap_user: string | null;
      imap_cred_enc: Buffer | null;
    }>(
      `SELECT m.user_id, m.mail_account_id, m.folder, m.uid, m.direction, m.message_id,
              a.imap_host, a.imap_port, a.imap_user, a.imap_cred_enc
         FROM messages m
         JOIN mail_accounts a ON a.id = m.mail_account_id
        WHERE m.id = $1`,
      [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    const m = r.rows[0];
    if (m.user_id !== userId) return reply.forbidden();

    let newFolder = m.folder;
    let newUid = m.uid;
    let imapMoved = false;
    if (m.imap_host && m.imap_port && m.imap_cred_enc) {
      const client = new ImapFlow({
        host: m.imap_host, port: m.imap_port, secure: true,
        auth: { user: m.imap_user || "", pass: decrypt(m.imap_cred_enc) },
        logger: false, socketTimeout: 25_000,
      });
      try {
        await client.connect();
        const mailboxes = await client.list();
        const trash = mailboxes.find(mb => mb.specialUse === "\\Trash");
        const allMail = mailboxes.find(mb => mb.specialUse === "\\All");
        const inbox = mailboxes.find(mb => mb.specialUse === "\\Inbox") || mailboxes.find(mb => mb.path.toUpperCase() === "INBOX");
        const sent = mailboxes.find(mb => mb.specialUse === "\\Sent");
        // Only try an IMAP move if the row is actually living in Trash.
        // DB-only recovers (no IMAP credentials, or a soft-delete that
        // pre-dates the move-on-delete behavior) still get their
        // deleted_at cleared below.
        if (trash && m.folder === trash.path) {
          const dest = m.direction === 'out' ? sent : inbox;
          if (dest) {
            let movedUid: number | undefined;
            const lock = await client.getMailboxLock(m.folder);
            try {
              const moveRes = await client.messageMove(String(m.uid), dest.path, { uid: true });
              const mapped = moveRes && (moveRes as { uidMap?: Map<number, number> }).uidMap?.get(m.uid);
              if (typeof mapped === "number") movedUid = mapped;
            } finally { lock.release(); }

            if (movedUid) {
              // Gmail: the row should point at All Mail, not INBOX/Sent.
              // Search All Mail by RFC Message-ID for the new UID — the
              // INBOX/Sent UID returned above is for a different folder
              // and isn't what our sync strategy expects.
              if (allMail && m.message_id) {
                const lock2 = await client.getMailboxLock(allMail.path);
                try {
                  const cleanMid = m.message_id.replace(/^<+|>+$/g, "");
                  const matched = (await client.search({ header: { "Message-ID": cleanMid } }, { uid: true })) as number[] | false;
                  if (matched && matched.length > 0) {
                    newFolder = allMail.path;
                    newUid = matched[matched.length - 1];
                    imapMoved = true;
                  }
                } finally { lock2.release(); }
              }
              if (!imapMoved) {
                // Non-Gmail (or All Mail lookup didn't find it): leave
                // the DB row pointing at the destination folder we just
                // moved into. Sync's permanent-delete detection will
                // reconcile any drift on the next pass.
                newFolder = dest.path;
                newUid = movedUid;
                imapMoved = true;
              }
            }
          }
        }
        await client.logout();
      } catch (e) {
        try { await client.logout(); } catch { /* ignore */ }
        req.log.warn({ err: e, messageId: req.params.id }, "recover: IMAP move-from-trash failed; DB-only restore");
      }
    }

    if (imapMoved) {
      await pool.query(
        `UPDATE messages SET deleted_at = NULL, folder = $1, uid = $2 WHERE id = $3`,
        [newFolder, newUid, req.params.id],
      );
    } else {
      await pool.query(
        `UPDATE messages SET deleted_at = NULL WHERE id = $1`,
        [req.params.id],
      );
    }
    return reply.code(204).send();
  });

  // ─── Per-contact-thread hide ("Only this") ──────────────────────────────
  // The multi-recipient delete dialog gives the user two choices:
  //   • All addressees → fall through to the normal /delete route (IMAP
  //     move-to-trash + DB deleted_at). Already covered above.
  //   • Only this one → the mail stays alive everywhere else; we just
  //     hide it from this specific contact's thread. That's what this
  //     pair of routes (POST + DELETE) toggles via message_contact_hides.
  //
  // The hide is per-(message, contact). FE filters out any messageList
  // entry whose (id, contactId) is in the hidden set after bootstrap.
  // RLS pins the row to the caller via user_id.
  app.post<{ Params: { id: string }; Body: { contact_id: string } }>(
    "/messages/:id/hide-for-contact", auth, async (req, reply) => {
      const contactId = (req.body || {}).contact_id;
      if (!contactId) return reply.badRequest("contact_id required");
      const pool = requirePool();
      const userId = req.authUser!.id;
      const mr = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM messages WHERE id = $1`, [req.params.id],
      );
      if (mr.rows.length === 0) return reply.notFound();
      if (mr.rows[0].user_id !== userId) return reply.forbidden();
      const cr = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM contacts WHERE id = $1`, [contactId],
      );
      if (cr.rows.length === 0) return reply.notFound();
      if (cr.rows[0].user_id !== userId) return reply.forbidden();
      await pool.query(
        `INSERT INTO message_contact_hides (message_id, contact_id, user_id)
              VALUES ($1, $2, $3)
         ON CONFLICT (message_id, contact_id) DO NOTHING`,
        [req.params.id, contactId, userId],
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { contact_id?: string } }>(
    "/messages/:id/hide-for-contact", auth, async (req, reply) => {
      const contactId = (req.query || {}).contact_id;
      if (!contactId) return reply.badRequest("contact_id query param required");
      const pool = requirePool();
      const userId = req.authUser!.id;
      await pool.query(
        `DELETE FROM message_contact_hides
          WHERE message_id = $1 AND contact_id = $2 AND user_id = $3`,
        [req.params.id, contactId, userId],
      );
      return reply.code(204).send();
    },
  );

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
