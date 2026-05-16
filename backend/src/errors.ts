// Transient-error detection + global Fastify error handler.
//
// Two upstream failure modes account for almost every 500 we see in
// production:
//
//   1. The Supavisor pooler kills the upstream Postgres connection
//      mid-query. pg surfaces this as a thrown error with SQLSTATE
//      "XX000" and message "(EDBHANDLEREXITED) connection to database
//      closed. Check logs for more information". Without a handler the
//      raw SQLSTATE leaks to the client as a confusing 500.
//
//   2. supabase-js (which uses Node's native fetch) intermittently
//      cannot reach the Supabase REST API from our Fly machine — the
//      call rejects with a TypeError whose message is just "fetch
//      failed". Same symptom: opaque 500 in the browser.
//
// Both are transient: the client should retry rather than show an
// error screen. We translate them to a clean 503 with a friendly
// message, log the full detail server-side, and let the frontend
// decide whether to auto-retry.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface ErrLike {
  code?: string;        // pg error.code (SQLSTATE) or system error code (ETIMEDOUT, …)
  message?: string;
  cause?: { code?: string; message?: string } | undefined;
  name?: string;
}

// Postgres SQLSTATE classes that mean "the server / connection is
// having trouble right now, retrying might work":
//  - 08*: connection_exception, connection_failure, …
//  - 57*: operator_intervention (statement_canceled = 57014)
//  - XX*: internal_error, including EDBHANDLEREXITED on Supavisor
const TRANSIENT_SQLSTATE_PREFIXES = ["08", "57", "XX"] as const;

// Node / undici / DNS errors that mean the network leg failed.
const TRANSIENT_SYSCALL_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND",
  "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrLike;
  const code = e.code || e.cause?.code;
  if (code) {
    if (TRANSIENT_SYSCALL_CODES.has(code)) return true;
    for (const p of TRANSIENT_SQLSTATE_PREFIXES) {
      if (code.startsWith(p)) return true;
    }
  }
  const msg = (e.message || "") + " " + (e.cause?.message || "");
  if (/fetch failed/i.test(msg)) return true;
  if (/EDBHANDLEREXITED/i.test(msg)) return true;
  if (/statement timeout/i.test(msg)) return true;
  if (/connection (?:closed|terminated|timeout)/i.test(msg)) return true;
  return false;
}

// Plain-language hint we surface to the client. Keep it short — the
// frontend can wrap this in a toast or a retry button.
export function transientMessage(err: unknown): string {
  const e = (err || {}) as ErrLike;
  const msg = e.message || "";
  if (/fetch failed/i.test(msg)) {
    return "Could not reach the database. Please try again.";
  }
  if (/EDBHANDLEREXITED/i.test(msg) || /connection (?:closed|terminated)/i.test(msg)) {
    return "Database connection was reset. Please try again.";
  }
  if (/statement timeout/i.test(msg)) {
    return "The database took too long to respond. Please try again.";
  }
  return "Service is temporarily unavailable. Please try again.";
}

// Convenience for inside-the-route error handling: detect transient
// supabase-js / pg results and send 503 instead of 500.
export function sendTransientOr500(
  reply: FastifyReply,
  err: unknown,
  fallbackMessage?: string,
): FastifyReply {
  if (isTransientError(err)) {
    reply.log.warn({ err }, "transient upstream error → 503");
    return reply.code(503).send({
      statusCode: 503,
      error: "Service Unavailable",
      message: transientMessage(err),
    });
  }
  reply.log.error({ err }, "internal error → 500");
  const msg = fallbackMessage || (err as ErrLike)?.message || "Internal Server Error";
  return reply.code(500).send({
    statusCode: 500,
    error: "Internal Server Error",
    message: msg,
  });
}

// Wire up the global error handler so uncaught throws (e.g. a raw
// pool.query() rejection in a route that has no try/catch) become a
// clean 503 too. Fastify only calls this for errors that bubble out of
// the route handler — explicit reply.internalServerError() calls in
// the route still go through as-is, which is why the route-side
// helpers above exist.
export function setupErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (isTransientError(err)) {
      reply.log.warn({ err }, "transient upstream error → 503");
      return reply.code(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: transientMessage(err),
      });
    }
    // Validation, auth, rate-limit etc. carry their own statusCode +
    // structured response — pass through unchanged.
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        statusCode,
        error: err.name || "Error",
        message: err.message,
      });
    }
    reply.log.error({ err }, "unhandled internal error → 500");
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: err.message || "Internal Server Error",
    });
  });
}
