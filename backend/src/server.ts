import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { authPreHandler } from "./auth.js";
import { setupErrorHandler } from "./errors.js";
import { registerMailAccountsRoutes } from "./routes/mailAccounts.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerContactsRoutes } from "./routes/contacts.js";
import { registerDraftsRoutes } from "./routes/drafts.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { registerTagsRoutes } from "./routes/tags.js";
import { registerR2mRoutes } from "./routes/r2m.js";
import { registerSignaturesRoutes } from "./routes/signatures.js";
import { registerInvitesRoutes } from "./routes/invites.js";
import { registerUserAuthRoutes } from "./routes/userAuth.js";
import { registerUserCryptoRoutes } from "./routes/userCrypto.js";

const app = Fastify({
  logger: {
    level: config.env === "production" ? "info" : "debug",
  },
});

await app.register(sensible);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

// Globally translate transient Postgres / supabase-js errors (Supavisor
// pooler drops, "fetch failed" from the SDK, statement timeouts, …) to
// a clean 503 instead of leaking SQLSTATE codes to the client. See
// errors.ts for the full reasoning.
setupErrorHandler(app);

// Security headers. Defaults give us: X-Frame-Options DENY, X-Content-
// Type-Options nosniff, Referrer-Policy no-referrer, HSTS, etc. We turn
// off the default Content-Security-Policy because the JSON API doesn't
// serve HTML (the frontend has its own CSP needs and lives on GitHub
// Pages), and we drop crossOriginResourcePolicy so the frontend can
// still fetch responses cross-origin.
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
});

// Rate limiting: a sane global ceiling stops a runaway client or naive
// scraper. Auth + invite paths get a stricter override below — those are
// the brute-force-worthy ones.
await app.register(rateLimit, {
  global: true,
  // v0.0.251: bump from 300 to 800/minute. Encryption backfill (Phase
  // 1.3c) walks ~20 batches in 20s plus the usual bootstrap refreshes
  // and Realtime-triggered re-fetches; 300/min started hitting 429 on
  // a moderately busy unlock session. 800/min still flags a runaway
  // client at twice that volume.
  max: 800,
  timeWindow: "1 minute",
  // Key by JWT subject when present, else by IP. That stops a single
  // user from accidentally hammering us regardless of their IP, while
  // unauthenticated traffic is still IP-bound.
  keyGenerator: (req) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return "jwt:" + auth.slice(7, 39); // first 32 chars is plenty for keying
    }
    return req.ip;
  },
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: "Too Many Requests",
    message: `Rate limit exceeded, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
  }),
});

await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map(s => s.trim()).filter(Boolean),
  credentials: true,
  // @fastify/cors defaults to GET,HEAD,POST — we also need PATCH/DELETE for
  // our CRUD endpoints (mail-accounts, drafts, messages/:id/flags).
  methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// Bumped on every backend deploy (lockstep with index.html's APP_VERSION),
// so we can curl /health and verify which build is actually running on
// Fly — useful when investigating whether a code change actually shipped.
const BACKEND_VERSION = "0.0.271";

app.get("/health", async () => ({
  status: "ok",
  service: "convotrail-backend",
  version: BACKEND_VERSION,
  env: config.env,
  time: new Date().toISOString(),
}));

app.get("/me", { preHandler: authPreHandler }, async (req) => ({
  user: req.authUser,
}));

await registerMailAccountsRoutes(app);
await registerDataRoutes(app);
await registerContactsRoutes(app);
await registerDraftsRoutes(app);
await registerMessagesRoutes(app);
await registerTagsRoutes(app);
await registerR2mRoutes(app);
await registerSignaturesRoutes(app);
await registerInvitesRoutes(app);
await registerUserAuthRoutes(app);
await registerUserCryptoRoutes(app);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ConvoTrail backend listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
