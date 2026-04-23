// Drafts CRUD. Drafts are created/updated explicitly via "Save draft" in
// Compose; closing without saving persists nothing. Drafts are read via
// /bootstrap, so there is no dedicated GET here.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";
import {
  uploadAttachment, downloadAttachmentBytes, deleteAttachments,
  MAX_ATTACHMENT_BYTES,
} from "../storage.js";

function splitAddresses(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function toJsonEmails(s: string | undefined, role: "to" | "cc" | "bcc") {
  return splitAddresses(s).map(email => ({ email, role }));
}

interface DraftBody {
  mail_account_id?: string | null;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  reply_to_id?: string | null;
  // Compose-time tag names. Inherited from the original on reply, then
  // carried through draft save/send so the sent row gets the same tags.
  tags?: string[];
}

export async function registerDraftsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Create draft ────────────────────────────────────────────────────────
  app.post<{ Body: DraftBody }>("/drafts", auth, async (req, reply) => {
    const b = req.body || {};
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("drafts")
      .insert({
        user_id: req.authUser!.id,
        mail_account_id: b.mail_account_id || null,
        to_emails: toJsonEmails(b.to, "to"),
        cc_emails: toJsonEmails(b.cc, "cc"),
        bcc_emails: toJsonEmails(b.bcc, "bcc"),
        subject: b.subject ?? null,
        body: b.body ?? null,
        reply_to_message_id: b.reply_to_id || null,
        tags: Array.isArray(b.tags) ? b.tags : [],
      })
      .select("id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, reply_to_message_id, tags, created_at, modified_at")
      .single();
    if (error) return reply.internalServerError(error.message);
    return { draft: data };
  });

  // ─── Update draft (partial; any provided field replaces, null allowed) ───
  app.patch<{ Params: { id: string }; Body: DraftBody }>("/drafts/:id", auth, async (req, reply) => {
    const { id } = req.params;
    const b = req.body || {};
    const pool = requirePool();

    const r0 = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM drafts WHERE id = $1`, [id],
    );
    if (r0.rows.length === 0) return reply.notFound();
    if (r0.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const sets: string[] = ["modified_at = now()"];
    const vals: unknown[] = [];
    let p = 1;
    const setField = (col: string, val: unknown) => { sets.push(`${col} = $${p++}`); vals.push(val); };

    if (b.mail_account_id !== undefined) setField("mail_account_id", b.mail_account_id || null);
    if (b.to !== undefined)              setField("to_emails", JSON.stringify(toJsonEmails(b.to, "to")));
    if (b.cc !== undefined)              setField("cc_emails", JSON.stringify(toJsonEmails(b.cc, "cc")));
    if (b.bcc !== undefined)             setField("bcc_emails", JSON.stringify(toJsonEmails(b.bcc, "bcc")));
    if (b.subject !== undefined)         setField("subject", b.subject ?? null);
    if (b.body !== undefined)            setField("body", b.body ?? null);
    if (b.reply_to_id !== undefined)     setField("reply_to_message_id", b.reply_to_id || null);
    if (Array.isArray(b.tags))           setField("tags", JSON.stringify(b.tags));

    vals.push(id);
    await pool.query(`UPDATE drafts SET ${sets.join(", ")} WHERE id = $${p}`, vals);
    return reply.code(204).send();
  });

  // ─── Delete draft ────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/drafts/:id", auth, async (req, reply) => {
    const pool = requirePool();
    // Collect storage keys first so we can remove the blobs after the row
    // cascade takes draft_attachments with it.
    const keysRes = await pool.query<{ storage_key: string }>(
      `SELECT da.storage_key FROM draft_attachments da
         JOIN drafts d ON d.id = da.draft_id
        WHERE da.draft_id = $1 AND d.user_id = $2`,
      [req.params.id, req.authUser!.id],
    );
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("drafts").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    if (keysRes.rows.length > 0) {
      try { await deleteAttachments(keysRes.rows.map(r => r.storage_key)); }
      catch (e) { req.log.warn({ err: e }, "draft delete: storage cleanup failed"); }
    }
    return reply.code(204).send();
  });

  // ─── Upload an attachment to a draft (multipart) ────────────────────────
  app.post<{ Params: { id: string } }>("/drafts/:id/attachments", auth, async (req, reply) => {
    const pool = requirePool();
    // Ownership check — draft_attachments has its own RLS, but we also want
    // the readable error when the draft id is wrong before we touch storage.
    const own = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM drafts WHERE id = $1`, [req.params.id],
    );
    if (own.rows.length === 0) return reply.notFound();
    if (own.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const file = await req.file();
    if (!file) return reply.badRequest("no file provided");
    const buf = await file.toBuffer();
    if (buf.length === 0) return reply.badRequest("empty file");
    if (buf.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ ok: false, error: "file too large (>25 MB)" });
    const cumul = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(size), 0)::text AS total FROM draft_attachments WHERE draft_id = $1`,
      [req.params.id],
    );
    if (Number(cumul.rows[0].total) + buf.length > MAX_ATTACHMENT_BYTES) {
      return reply.code(413).send({ ok: false, error: "total attachments exceed 25 MB" });
    }

    const safeName = (file.filename || "attachment").replace(/[\r\n]+/g, " ").slice(0, 200);
    const key = `${req.authUser!.id}/${req.params.id}/${randomUUID()}-${safeName}`;
    try {
      await uploadAttachment(key, buf, file.mimetype);
    } catch (e) {
      return reply.internalServerError(`upload failed: ${(e as Error).message}`);
    }
    const ins = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO draft_attachments (draft_id, user_id, storage_key, filename, content_type, size)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, created_at`,
      [req.params.id, req.authUser!.id, key, safeName, file.mimetype || null, buf.length],
    );
    // Bump the draft's modified_at so the thread sort reflects this change.
    await pool.query(`UPDATE drafts SET modified_at = now() WHERE id = $1`, [req.params.id]);
    return {
      attachment: {
        id: ins.rows[0].id,
        filename: safeName,
        content_type: file.mimetype || null,
        size: buf.length,
        created_at: ins.rows[0].created_at,
      },
    };
  });

  // ─── Remove one attachment from a draft ─────────────────────────────────
  app.delete<{ Params: { id: string; attId: string } }>("/drafts/:id/attachments/:attId", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ storage_key: string; user_id: string }>(
      `SELECT storage_key, user_id FROM draft_attachments WHERE id = $1 AND draft_id = $2`,
      [req.params.attId, req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();
    await pool.query(`DELETE FROM draft_attachments WHERE id = $1`, [req.params.attId]);
    try { await deleteAttachments([r.rows[0].storage_key]); }
    catch (e) { req.log.warn({ err: e }, "attachment delete: storage cleanup failed"); }
    return reply.code(204).send();
  });

  // ─── Download an attachment for in-compose preview ─────────────────────
  app.get<{ Params: { id: string; attId: string } }>("/drafts/:id/attachments/:attId", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ storage_key: string; filename: string; content_type: string | null; size: string; user_id: string }>(
      `SELECT storage_key, filename, content_type, size::text, user_id
         FROM draft_attachments WHERE id = $1 AND draft_id = $2`,
      [req.params.attId, req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    let bytes: Buffer;
    try { bytes = await downloadAttachmentBytes(r.rows[0].storage_key); }
    catch (e) { return reply.code(502).send({ ok: false, error: `storage fetch failed: ${(e as Error).message}` }); }
    const safe = r.rows[0].filename.replace(/"/g, "");
    reply
      .type(r.rows[0].content_type || "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`)
      .header("Content-Length", String(bytes.length));
    return reply.send(bytes);
  });
}
