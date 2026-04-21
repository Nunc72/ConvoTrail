// Tags CRUD + per-message attach/detach.
// Tags live in a dedicated `tags` table, joined to messages via `message_tags`.
// POST /messages/:id/tags accepts either an existing tag_id OR a free-form name
// (which is create-or-get), so the frontend can keep working in tag names while
// we handle the name-to-id mapping server-side.
import type { FastifyInstance } from "fastify";
import { supabaseWithJwt } from "../supabase.js";
import { authPreHandler } from "../auth.js";

interface TagInput {
  name: string;
}
interface AttachInput {
  tag_id?: string;
  name?: string;
}

export async function registerTagsRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  // ─── List all tags for the user ──────────────────────────────────────────
  app.get("/tags", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("tags")
      .select("id, name, archived_at, created_at")
      .order("name", { ascending: true });
    if (error) return reply.internalServerError(error.message);
    return { tags: data };
  });

  // ─── Create-or-get a tag by name ─────────────────────────────────────────
  app.post<{ Body: TagInput }>("/tags", auth, async (req, reply) => {
    const name = (req.body?.name || "").trim();
    if (!name) return reply.badRequest("name required");
    const sb = supabaseWithJwt(req.authJwt!);
    // Try insert; on unique-violation, fetch existing.
    const ins = await sb
      .from("tags")
      .insert({ user_id: req.authUser!.id, name })
      .select("id, name, archived_at, created_at")
      .single();
    if (!ins.error) return { tag: ins.data };
    // Duplicate → fetch
    const sel = await sb.from("tags").select("id, name, archived_at, created_at").eq("name", name).maybeSingle();
    if (sel.error || !sel.data) return reply.internalServerError(ins.error.message);
    return { tag: sel.data };
  });

  // ─── Rename / archive / set per-email roles ──────────────────────────────
  // email_roles is a JSONB map { email: role } that governs how messages
  // addressed to/from each participant get tagged. Passing an explicit {}
  // clears it.
  app.patch<{
    Params: { id: string };
    Body: { name?: string; archived?: boolean; email_roles?: Record<string, string> };
  }>("/tags/:id", auth, async (req, reply) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.archived === "boolean") patch.archived_at = b.archived ? new Date().toISOString() : null;
    if (b.email_roles && typeof b.email_roles === "object") patch.email_roles = b.email_roles;
    if (Object.keys(patch).length === 0) return reply.badRequest("nothing to update");
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb.from("tags").update(patch).eq("id", req.params.id);
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });

  // ─── Attach a tag to a message (create-or-get by name if no tag_id) ──────
  app.post<{ Params: { id: string }; Body: AttachInput }>(
    "/messages/:id/tags", auth, async (req, reply) => {
      const msgId = req.params.id;
      const b = req.body || {};
      const sb = supabaseWithJwt(req.authJwt!);

      // Resolve tag (create-or-get by name, or use supplied id)
      let tagId = b.tag_id;
      let tag: { id: string; name: string; archived_at: string | null; created_at: string } | null = null;
      if (!tagId) {
        const name = (b.name || "").trim();
        if (!name) return reply.badRequest("tag_id or name required");
        const ins = await sb.from("tags").insert({ user_id: req.authUser!.id, name })
          .select("id, name, archived_at, created_at").single();
        if (!ins.error) tag = ins.data;
        else {
          const sel = await sb.from("tags").select("id, name, archived_at, created_at").eq("name", name).maybeSingle();
          if (sel.error || !sel.data) return reply.internalServerError(ins.error.message);
          tag = sel.data;
        }
        tagId = tag!.id;
      } else {
        const sel = await sb.from("tags").select("id, name, archived_at, created_at").eq("id", tagId).maybeSingle();
        if (sel.error || !sel.data) return reply.notFound("tag not found");
        tag = sel.data;
      }

      // Attach (no-op if already linked)
      const { error } = await sb.from("message_tags").upsert(
        { message_id: msgId, tag_id: tagId, user_id: req.authUser!.id },
        { onConflict: "message_id,tag_id", ignoreDuplicates: true },
      );
      if (error) return reply.internalServerError(error.message);
      return { tag };
    },
  );

  // ─── Detach a tag from a message ─────────────────────────────────────────
  app.delete<{ Params: { id: string; tag_id: string } }>(
    "/messages/:id/tags/:tag_id", auth, async (req, reply) => {
      const sb = supabaseWithJwt(req.authJwt!);
      const { error } = await sb.from("message_tags").delete()
        .eq("message_id", req.params.id)
        .eq("tag_id", req.params.tag_id);
      if (error) return reply.internalServerError(error.message);
      return reply.code(204).send();
    },
  );
}
