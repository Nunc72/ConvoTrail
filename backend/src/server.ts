import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { config } from "./config.js";
import { authPreHandler } from "./auth.js";
import { registerMailAccountsRoutes } from "./routes/mailAccounts.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerContactsRoutes } from "./routes/contacts.js";
import { registerDraftsRoutes } from "./routes/drafts.js";
import { registerMessagesRoutes } from "./routes/messages.js";

const app = Fastify({
  logger: {
    level: config.env === "production" ? "info" : "debug",
  },
});

await app.register(sensible);
await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","),
  credentials: true,
  // @fastify/cors defaults to GET,HEAD,POST — we also need PATCH/DELETE for
  // our CRUD endpoints (mail-accounts, drafts, messages/:id/flags).
  methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

app.get("/health", async () => ({
  status: "ok",
  service: "convotrail-backend",
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

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ConvoTrail backend listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
