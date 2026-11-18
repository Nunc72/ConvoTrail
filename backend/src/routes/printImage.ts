// v0.0.326 — POST /print-image { url }: one image of a mail, for the PDF
// that a Home Screen app on iOS makes instead of printing (print() does
// nothing there). Mail images live on the senders' servers, which don't
// allow cross-origin reads, so the app can't put them in a PDF itself;
// the backend fetches them (imageRelay.ts has the checks). The URL is
// sent in the body and never logged: image links in newsletters often
// carry a tracking id.
// v0.0.327 — { width } as well: the image comes back no wider than the
// PDF needs (shrinkForPrint).
import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { fetchPublicImage, RelayError, shrinkForPrint } from "../imageRelay.js";

const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export async function registerPrintImageRoutes(app: FastifyInstance) {
  app.post<{ Body: { url?: unknown; width?: unknown } }>("/print-image", {
    preHandler: authPreHandler,
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const raw = typeof req.body?.url === "string" ? req.body.url : "";
    if (!raw || raw.length > 8192) return reply.badRequest("url required");
    const width = Math.round(Number(req.body?.width));
    try {
      let img = await fetchPublicImage(raw, AbortSignal.timeout(25_000));
      if (width > 0) img = await shrinkForPrint(img, Math.min(Math.max(width, 16), 2400));
      return reply
        .header("content-type", img.type)
        .header("cache-control", "private, no-store")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(img.body);
    } catch (e) {
      const err = e as Error & { code?: string };
      const status = e instanceof RelayError ? e.statusCode
        : err.code === "EBLOCKED" ? 400
        : err.name === "TimeoutError" || err.name === "AbortError" || TIMEOUT_CODES.has(err.code ?? "") ? 504
        : 502;
      let host = "";
      try { host = new URL(raw).hostname; } catch { /* invalid URL */ }
      req.log.info({ host, status, reason: err.code || err.message }, "print-image failed");
      return reply.code(status).send({ statusCode: status, error: "Image unavailable", message: err.message });
    }
  });
}
