import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { encrypt, decrypt } from "../crypto.js";
import { testImapConnection } from "../imap.js";
import { authPreHandler } from "../auth.js";
import { syncAccount } from "../sync.js";
import { requirePool } from "../db.js";
import { sendMail, splitAddresses } from "../smtp.js";
import { armR2m } from "../r2m.js";
import { downloadAttachmentBytes, deleteAttachments } from "../storage.js";

interface AccountInput {
  email: string;
  provider: "generic" | "icloud" | "gmail";
  display_name?: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_password?: string;
  // Retention / auto-sync preferences (nullable ints; null = keep forever)
  retention_deleted_days?: number | null;
  retention_spam_days?: number | null;
  auto_sync?: boolean;
}

export async function registerMailAccountsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── List accounts (no secrets) ─────────────────────────────────────────
  app.get("/mail-accounts", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("mail_accounts")
      .select(
        "id, email, provider, display_name, imap_host, imap_port, imap_user, " +
        "smtp_host, smtp_port, smtp_user, last_sync_at, last_error, created_at, " +
        "retention_deleted_days, retention_spam_days, auto_sync",
      )
      .order("created_at", { ascending: true });
    if (error) return reply.internalServerError(error.message);
    return { accounts: data };
  });

  // ─── Test connection without saving (for "Test & save" UX) ──────────────
  app.post<{ Body: AccountInput }>("/mail-accounts/test", auth, async (req, reply) => {
    const b = req.body;
    if (!b.imap_host || !b.imap_port || !b.imap_user || !b.imap_password) {
      return reply.badRequest("imap_host, imap_port, imap_user, imap_password required");
    }
    const result = await testImapConnection({
      host: b.imap_host,
      port: b.imap_port,
      user: b.imap_user,
      pass: b.imap_password,
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, mailboxCount: result.mailboxCount };
  });

  // ─── Create account (credentials encrypted at rest) ─────────────────────
  app.post<{ Body: AccountInput }>("/mail-accounts", auth, async (req, reply) => {
    const b = req.body;
    if (!b.email || !b.provider) return reply.badRequest("email and provider required");

    // Use direct pg for bytea fields — supabase-js serializes Buffer as JSON object.
    const pool = requirePool();
    const imapEnc = b.imap_password ? encrypt(b.imap_password) : null;
    const smtpEnc = b.smtp_password ? encrypt(b.smtp_password) : null;
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO mail_accounts (
           user_id, email, provider, display_name,
           imap_host, imap_port, imap_user, imap_cred_enc,
           smtp_host, smtp_port, smtp_user, smtp_cred_enc,
           retention_deleted_days, retention_spam_days, auto_sync
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, email, provider, display_name, imap_host, imap_port, imap_user,
                   smtp_host, smtp_port, smtp_user, retention_deleted_days,
                   retention_spam_days, auto_sync, created_at`,
        [
          req.authUser!.id, b.email, b.provider, b.display_name ?? null,
          b.imap_host ?? null, b.imap_port ?? null, b.imap_user ?? null, imapEnc,
          b.smtp_host ?? null, b.smtp_port ?? null, b.smtp_user ?? null, smtpEnc,
          b.retention_deleted_days ?? null, b.retention_spam_days ?? null,
          b.auto_sync ?? false,
        ],
      );
      return { account: r.rows[0] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate key")) return reply.conflict("An account with this email already exists");
      return reply.internalServerError(msg);
    }
  });

  // ─── Update account (partial) ────────────────────────────────────────────
  // Email is read-only. Passwords are only re-encrypted when non-empty values
  // are provided — an empty/missing password field leaves the existing creds
  // untouched, so the user can edit display_name or hosts without re-typing.
  app.patch<{ Params: { id: string }; Body: Partial<AccountInput> }>("/mail-accounts/:id", auth, async (req, reply) => {
    const id = req.params.id;
    const b = req.body;
    const pool = requirePool();

    const r0 = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM mail_accounts WHERE id = $1`, [id],
    );
    if (r0.rows.length === 0) return reply.notFound();
    if (r0.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const sets: string[] = [];
    const vals: unknown[] = [];
    let p = 1;
    const setField = (col: string, val: unknown) => { sets.push(`${col} = $${p++}`); vals.push(val); };

    if (b.display_name !== undefined) setField("display_name", b.display_name || null);
    if (b.imap_host     !== undefined) setField("imap_host",    b.imap_host || null);
    if (b.imap_port     !== undefined) setField("imap_port",    b.imap_port || null);
    if (b.imap_user     !== undefined) setField("imap_user",    b.imap_user || null);
    if (b.imap_password)               setField("imap_cred_enc", encrypt(b.imap_password));
    if (b.smtp_host     !== undefined) setField("smtp_host",    b.smtp_host || null);
    if (b.smtp_port     !== undefined) setField("smtp_port",    b.smtp_port || null);
    if (b.smtp_user     !== undefined) setField("smtp_user",    b.smtp_user || null);
    if (b.smtp_password)               setField("smtp_cred_enc", encrypt(b.smtp_password));
    if (b.retention_deleted_days !== undefined) setField("retention_deleted_days", b.retention_deleted_days);
    if (b.retention_spam_days    !== undefined) setField("retention_spam_days",    b.retention_spam_days);
    if (b.auto_sync              !== undefined) setField("auto_sync",              !!b.auto_sync);

    if (sets.length === 0) return reply.badRequest("no updatable fields provided");

    vals.push(id);
    await pool.query(
      `UPDATE mail_accounts SET ${sets.join(", ")} WHERE id = $${p}`,
      vals,
    );
    return reply.code(204).send();
  });

  // ─── Delete account ─────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/mail-accounts/:id", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("mail_accounts").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });

  // ─── Sync account (fetch last 90d INBOX + Sent, upsert messages + contacts) ─
  app.post<{ Params: { id: string } }>("/mail-accounts/:id/sync", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM mail_accounts WHERE id = $1`, [req.params.id],
    );
    if (r.rows.length === 0) return reply.notFound();
    if (r.rows[0].user_id !== req.authUser!.id) return reply.forbidden();

    const result = await syncAccount(req.params.id);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  // ─── List synced messages for an account (MVP: latest N) ────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/mail-accounts/:id/messages", auth, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("messages")
      .select("id, folder, uid, from_email, from_name, subject, snippet, date, direction, flags")
      .eq("mail_account_id", req.params.id)
      .order("date", { ascending: false })
      .limit(limit);
    if (error) return reply.internalServerError(error.message);
    return { messages: data };
  });

  // ─── Send a mail (SMTP + best-effort APPEND to Sent) ─────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      to: string; cc?: string; bcc?: string; subject?: string; body?: string;
      reply_to_id?: string;
      // When set, arm revert-to-me on the new outgoing message. 0 days =
      // active immediately (useful for testing); higher values delay until
      // that many days after send.
      revert2me_days?: number;
      // When set, the draft's attachments are pulled from storage, added to
      // the outgoing MIME, and — on successful delivery — the draft row +
      // storage blobs are removed (CASCADE handles draft_attachments rows).
      draft_id?: string;
      // Tag names to attach to the newly-inserted Sent row. On reply the
      // frontend inherits these from the original message; on send we
      // create-or-get each tag and drop message_tags rows.
      tags?: string[];
    };
  }>("/mail-accounts/:id/send", auth, async (req, reply) => {
    const { id } = req.params;
    const b = req.body || ({} as typeof req.body);
    if (!b.to || !b.to.trim()) return reply.badRequest("to required");

    const pool = requirePool();
    const r = await pool.query<{
      user_id: string; email: string; display_name: string | null;
      imap_host: string | null; imap_port: number | null; imap_user: string | null; imap_cred_enc: Buffer | null;
      smtp_host: string | null; smtp_port: number | null; smtp_user: string | null; smtp_cred_enc: Buffer | null;
    }>(
      `SELECT user_id, email, display_name,
              imap_host, imap_port, imap_user, imap_cred_enc,
              smtp_host, smtp_port, smtp_user, smtp_cred_enc
         FROM mail_accounts WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) return reply.notFound();
    const acc = r.rows[0];
    if (acc.user_id !== req.authUser!.id) return reply.forbidden();
    if (!acc.smtp_host || !acc.smtp_port || !acc.smtp_cred_enc) return reply.badRequest("SMTP not configured for this account");
    if (!acc.imap_host || !acc.imap_port || !acc.imap_cred_enc) return reply.badRequest("IMAP not configured for this account");

    // Threading: resolve RFC Message-ID of the message we are replying to (if any)
    let inReplyTo: string | null = null;
    if (b.reply_to_id) {
      const rr = await pool.query<{ message_id: string | null }>(
        `SELECT message_id FROM messages WHERE id = $1 AND user_id = $2`,
        [b.reply_to_id, req.authUser!.id],
      );
      if (rr.rows[0]?.message_id) inReplyTo = rr.rows[0].message_id;
    }

    // Pull draft attachments (if any) from storage before we send.
    let draftAttachments: { filename: string; content: Buffer; contentType?: string }[] = [];
    let draftStorageKeys: string[] = [];
    if (b.draft_id) {
      const r2 = await pool.query<{ storage_key: string; filename: string; content_type: string | null }>(
        `SELECT da.storage_key, da.filename, da.content_type
           FROM draft_attachments da
           JOIN drafts d ON d.id = da.draft_id
          WHERE d.id = $1 AND d.user_id = $2`,
        [b.draft_id, req.authUser!.id],
      );
      draftStorageKeys = r2.rows.map(x => x.storage_key);
      for (const row of r2.rows) {
        try {
          const bytes = await downloadAttachmentBytes(row.storage_key);
          draftAttachments.push({
            filename: row.filename,
            content: bytes,
            contentType: row.content_type || undefined,
          });
        } catch (e) {
          req.log.warn({ err: e, key: row.storage_key }, "send: attachment fetch failed");
        }
      }
    }

    const result = await sendMail({
      smtp: { host: acc.smtp_host, port: acc.smtp_port, user: acc.smtp_user || acc.email, pass: decrypt(acc.smtp_cred_enc) },
      imap: { host: acc.imap_host, port: acc.imap_port, user: acc.imap_user || acc.email, pass: decrypt(acc.imap_cred_enc) },
      fromEmail: acc.email,
      fromName: acc.display_name,
      to: b.to,
      cc: b.cc,
      bcc: b.bcc,
      subject: b.subject || "",
      text: b.body || "",
      inReplyTo,
      references: inReplyTo,
      attachments: draftAttachments,
    });

    if (!result.ok) return reply.code(400).send(result);

    // If APPEND succeeded and returned a UID, record the outgoing message so
    // it shows up in the UI immediately (next sync would pick it up anyway).
    if (result.appended) {
      const toList = splitAddresses(b.to).map(email => ({ email, role: "to" }))
        .concat(splitAddresses(b.cc).map(email => ({ email, role: "cc" })))
        .concat(splitAddresses(b.bcc).map(email => ({ email, role: "bcc" })));
      const snippet = (b.body || "").substring(0, 200);

      // Make sure each recipient has a contact + contact_emails row.
      // Without this, sending to a brand-new address inserts the message
      // but the UI's email->contact_id lookup misses, the message is
      // filtered out (frontend drops m.contactId === null rows), and the
      // user sees neither the new contact nor the sent mail until the
      // next IMAP Sent-folder sync runs.
      const recipientEmails = Array.from(new Set(
        toList.map(t => (t.email || "").toLowerCase()).filter(Boolean),
      ));
      if (recipientEmails.length > 0) {
        try {
          const existing = await pool.query<{ email: string }>(
            `SELECT email FROM contact_emails WHERE user_id = $1 AND email = ANY($2::text[])`,
            [req.authUser!.id, recipientEmails],
          );
          const have = new Set(existing.rows.map(r => r.email.toLowerCase()));
          for (const email of recipientEmails) {
            if (have.has(email)) continue;
            const local = email.split("@")[0];
            const guessedName = local.split(/[._-]+/).filter(Boolean)
              .map(p => p[0].toUpperCase() + p.slice(1)).join(" ") || email;
            const cIns = await pool.query<{ id: string }>(
              `INSERT INTO contacts (user_id, name, primary_email)
                 VALUES ($1, $2, $3)
                 RETURNING id`,
              [req.authUser!.id, guessedName, email],
            );
            const newContactId = cIns.rows[0]?.id;
            if (newContactId) {
              await pool.query(
                `INSERT INTO contact_emails (contact_id, user_id, email)
                   VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [newContactId, req.authUser!.id, email],
              );
            }
          }
        } catch (e) {
          req.log.warn({ err: e }, "send: contact upsert failed");
        }
      }

      try {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO messages (
             user_id, mail_account_id, folder, uid, uidvalidity, message_id,
             from_email, from_name, to_emails, subject, body_text, snippet,
             date, flags, direction, has_attachments
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12, now(), $13::jsonb, 'out', $14)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            req.authUser!.id, id,
            result.appended.folder, result.appended.uid, result.appended.uidValidity, result.messageId || null,
            acc.email, acc.display_name,
            JSON.stringify(toList), b.subject || "", b.body || "", snippet,
            JSON.stringify({ seen: true }),
            draftAttachments.length > 0,
          ],
        );
        const newMessageId = ins.rows[0]?.id;
        // Arm revert-to-me if requested.
        if (newMessageId && typeof b.revert2me_days === "number" && b.revert2me_days >= 0) {
          try {
            await armR2m(newMessageId, req.authUser!.id, b.revert2me_days);
          } catch (e) {
            req.log.warn({ err: e }, "send: arming r2m failed");
          }
        }
        // Attach tags to the sent row. Tag names come from the compose pane
        // (inherited from the original on reply). Each name is create-or-got
        // against the user's tags; message_tags rows are upserted.
        if (newMessageId && Array.isArray(b.tags) && b.tags.length > 0) {
          try {
            for (const rawName of b.tags) {
              const name = (rawName || "").trim();
              if (!name) continue;
              // Create-or-get the tag
              let tagId: string | null = null;
              const ins1 = await pool.query<{ id: string }>(
                `INSERT INTO tags (user_id, name) VALUES ($1, $2)
                 ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [req.authUser!.id, name],
              );
              tagId = ins1.rows[0]?.id || null;
              if (!tagId) continue;
              await pool.query(
                `INSERT INTO message_tags (message_id, tag_id, user_id)
                   VALUES ($1, $2, $3)
                 ON CONFLICT (message_id, tag_id) DO NOTHING`,
                [newMessageId, tagId, req.authUser!.id],
              );
            }
          } catch (e) {
            req.log.warn({ err: e }, "send: tag attach failed");
          }
        }
      } catch (e) {
        // Non-fatal — the mail is delivered and sits in the server's Sent folder.
        req.log.warn({ err: e }, "send: insert into messages failed");
      }
    }

    // Clean up the draft (row CASCADE removes draft_attachments; we still
    // have to sweep the storage objects ourselves).
    if (b.draft_id) {
      try {
        await pool.query(`DELETE FROM drafts WHERE id = $1 AND user_id = $2`, [b.draft_id, req.authUser!.id]);
      } catch (e) {
        req.log.warn({ err: e }, "send: draft delete failed");
      }
      if (draftStorageKeys.length > 0) {
        try { await deleteAttachments(draftStorageKeys); }
        catch (e) { req.log.warn({ err: e }, "send: storage cleanup failed"); }
      }
    }

    return result;
  });

  // ─── Test connection for existing saved account ─────────────────────────
  app.post<{ Params: { id: string } }>("/mail-accounts/:id/test", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{
      user_id: string; imap_host: string; imap_port: number; imap_user: string; imap_cred_enc: Buffer | null;
    }>(
      `SELECT user_id, imap_host, imap_port, imap_user, imap_cred_enc
         FROM mail_accounts WHERE id = $1`,
      [req.params.id],
    );
    const row = r.rows[0];
    if (!row) return reply.notFound("Account not found");
    if (row.user_id !== req.authUser!.id) return reply.forbidden();
    if (!row.imap_cred_enc) return reply.badRequest("No stored IMAP password");

    const password = decrypt(row.imap_cred_enc);
    const result = await testImapConnection({
      host: row.imap_host, port: row.imap_port,
      user: row.imap_user, pass: password,
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, mailboxCount: result.mailboxCount };
  });
}
