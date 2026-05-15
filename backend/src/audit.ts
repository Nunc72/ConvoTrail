// Append-only audit log. Best-effort fire-and-forget — never throws,
// never blocks the request, since the user shouldn't see a "your action
// succeeded but we couldn't log it" error.
//
// Retention is enforced opportunistically by maybeCleanupAuditLog,
// called with a 1% probability from /bootstrap (see routes/data.ts).
// At ~one /bootstrap per session, that's daily cleanup on a single-
// active-user app and roughly continuous on a busier one — without
// cron infrastructure.
import type { FastifyRequest } from "fastify";
import { supabaseAdmin } from "./supabase.js";

export interface AuditTarget { type: string; id: string }

export function logAudit(
  req: FastifyRequest,
  action: string,
  target?: AuditTarget,
  metadata?: Record<string, unknown>,
): void {
  if (!supabaseAdmin) return;
  // Fire and forget — don't await. The handler returns before this
  // resolves; failures are logged via req.log.warn but don't surface
  // to the caller.
  void supabaseAdmin.from("audit_log").insert({
    user_id:     req.authUser?.id ?? null,
    action,
    target_type: target?.type ?? null,
    target_id:   target?.id ?? null,
    metadata:    metadata ?? null,
    ip:          req.ip ?? null,
    user_agent:  req.headers["user-agent"] ?? null,
  }).then(({ error }) => {
    if (error) req.log.warn({ err: error, action }, "audit log insert failed");
  });
}

const AUDIT_RETENTION_DAYS = 180;

// Called with low probability from a hot path. Deletes rows older than
// the retention window. Best-effort; errors are logged and swallowed.
export function maybeCleanupAuditLog(req: FastifyRequest, probability = 0.01): void {
  if (!supabaseAdmin) return;
  if (Math.random() >= probability) return;
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString();
  void supabaseAdmin.from("audit_log").delete().lt("created_at", cutoff)
    .then(({ error, count }) => {
      if (error) req.log.warn({ err: error }, "audit log cleanup failed");
      else if (count) req.log.info({ deleted: count }, "audit log cleanup");
    });
}
