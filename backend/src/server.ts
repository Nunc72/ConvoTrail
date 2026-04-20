import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { config } from "./config.js";

const app = Fastify({
  logger: {
    level: config.env === "production" ? "info" : "debug",
  },
});

await app.register(sensible);
await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","),
  credentials: true,
});

app.get("/health", async () => ({
  status: "ok",
  service: "convotrail-backend",
  env: config.env,
  time: new Date().toISOString(),
}));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`ConvoTrail backend listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
