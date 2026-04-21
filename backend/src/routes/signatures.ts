// Signatures CRUD + per-account linkage (link + auto-insert flag).
// GET lives in /bootstrap so we don't add an extra request on load.
import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";
import { requirePool } from "../db.js";

interface SignatureInput {
  title?: string;
  body?: string;
  // Full replacement of the per-account linkage for this signature.
  account_links?: Array<{ mail_account_id: string; is_auto?: boolean }>;
}

async function writeAccountLinks(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> },
  signatureId: string,
  userId: string,
  links: NonNullable<SignatureInput["account_links"]>,
): Promise<void> {
  // Full replacement: wipe everything for this sig, then re-insert.
  await client.query(`DELETE FROM account_signatures WHERE signature_id = $1`, [signatureId]);
  for (const l of links) {
    if (!l.mail_account_id) continue;
    await client.query(
      `INSERT INTO account_signatures (mail_account_id, signature_id, user_id, is_auto)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (mail_account_id, signature_id) DO UPDATE SET is_auto = EXCLUDED.is_auto`,
      [l.mail_account_id, signatureId, userId, !!l.is_auto],
    );
  }
  // Enforce: at most one is_auto row per (mail_account_id) and per (signature_id)
  // by clearing any stale auto flags outside the newly-written set. For the
  // current signature this is already correct (we rewrote it), so we only
  // need to demote the "one auto per account" side:
  await client.query(
    `UPDATE account_signatures AS a
        SET is_auto = false
      WHERE a.signature_id <> $1
        AND a.user_id = $2
        AND a.is_auto = true
        AND EXISTS (
          SELECT 1 FROM account_signatures b
           WHERE b.signature_id = $1
             AND b.mail_account_id = a.mail_account_id
             AND b.is_auto = true
        )`,
    [signatureId, userId],
  );
}

export async function registerSignaturesRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── Create ──────────────────────────────────────────────────────────────
  app.post<{ Body: SignatureInput }>("/signatures", auth, async (req, reply) => {
    const title = (req.body?.title || "").trim();
    const body  = (req.body?.body  || "");
    if (!title) return reply.badRequest("title required");

    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("signatures")
      .insert({ user_id: req.authUser!.id, title, body })
      .select("id, title, body, created_at")
      .single();
    if (error) return reply.internalServerError(error.message);

    if (req.body?.account_links?.length) {
      const pool = requirePool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await writeAccountLinks(client, data.id, req.authUser!.id, req.body.account_links);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        return reply.internalServerError((e as Error).message);
      } finally {
        client.release();
      }
    }
    return { signature: data };
  });

  // ─── Update (title / body / account_links, any combination) ──────────────
  app.patch<{ Params: { id: string }; Body: SignatureInput }>(
    "/signatures/:id", auth, async (req, reply) => {
      const b = req.body || {};
      const sb = supabaseWithJwt(req.authJwt!);

      if (typeof b.title === "string" || typeof b.body === "string") {
        const patch: Record<string, unknown> = {};
        if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
        if (typeof b.body  === "string")                   patch.body  = b.body;
        if (Object.keys(patch).length > 0) {
          const { error } = await sb.from("signatures").update(patch).eq("id", req.params.id);
          if (error) return reply.internalServerError(error.message);
        }
      }

      if (Array.isArray(b.account_links)) {
        const pool = requirePool();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Ownership check (RLS would also guard, but cheap to verify).
          const own = await client.query<{ user_id: string }>(
            `SELECT user_id FROM signatures WHERE id = $1`, [req.params.id],
          );
          if (own.rows.length === 0) { await client.query("ROLLBACK"); return reply.notFound(); }
          if (own.rows[0].user_id !== req.authUser!.id) { await client.query("ROLLBACK"); return reply.forbidden(); }

          await writeAccountLinks(client, req.params.id, req.authUser!.id, b.account_links);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          return reply.internalServerError((e as Error).message);
        } finally {
          client.release();
        }
      }

      return reply.code(204).send();
    },
  );

  // ─── Delete ──────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/signatures/:id", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("signatures").delete().eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });
}
