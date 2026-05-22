// Endpoints for the per-user crypto material that powers Pad A
// (client-side end-to-end encryption). The backend is a passive
// store here — it never sees the master key, only the *wrapped*
// form (encrypted with a passphrase-derived key) and the random
// salt used for that derivation. Neither is a secret on its own.
//
// GET  /me/crypto  → returns the stored material so the client can
//                   prompt the user for the passphrase and unwrap the
//                   master key locally. 404 if the user hasn't set
//                   up a passphrase yet (= a fresh account, the FE
//                   should run the setup-passphrase flow).
// PUT  /me/crypto  → upsert the user's crypto material. Called once
//                   during setup, and again only if the user rotates
//                   their passphrase (which re-wraps the same master
//                   key with the new derived key, so existing
//                   encrypted data stays decryptable).
//
// Both routes are scoped to the caller's auth.uid() via Postgres RLS
// on the user_crypto table — no extra ownership check needed here.
import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../auth.js";
import { supabaseWithJwt } from "../supabase.js";

interface CryptoBody {
  passphrase_salt: string;     // base64
  wrapped_master_key: string;  // base64
  kdf_algorithm?: string;
  kdf_params?: Record<string, unknown>;
  cipher_algorithm?: string;
}

export async function registerUserCryptoRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  app.get("/me/crypto", auth, async (req, reply) => {
    const sb = supabaseWithJwt(req.authJwt!);
    const { data, error } = await sb
      .from("user_crypto")
      .select("passphrase_salt, wrapped_master_key, kdf_algorithm, kdf_params, cipher_algorithm")
      .eq("user_id", req.authUser!.id)
      .maybeSingle();
    if (error) return reply.internalServerError(error.message);
    if (!data) return reply.code(404).send({ setup_needed: true });
    // bytea round-trips as a base64-encoded string with a "\\x" hex prefix
    // through supabase-js; normalize so the client always gets clean
    // base64 strings.
    const normalize = (b: unknown): string => {
      if (typeof b !== "string") return "";
      if (b.startsWith("\\x")) return Buffer.from(b.slice(2), "hex").toString("base64");
      return b;
    };
    return {
      passphrase_salt:    normalize(data.passphrase_salt),
      wrapped_master_key: normalize(data.wrapped_master_key),
      kdf_algorithm:      data.kdf_algorithm,
      kdf_params:         data.kdf_params,
      cipher_algorithm:   data.cipher_algorithm,
    };
  });

  app.put<{ Body: CryptoBody }>("/me/crypto", auth, async (req, reply) => {
    const b = req.body || {} as CryptoBody;
    if (!b.passphrase_salt || !b.wrapped_master_key) {
      return reply.badRequest("passphrase_salt and wrapped_master_key required (base64)");
    }
    // Validate base64 + reasonable length. salt should be 16-64 bytes,
    // wrapped key includes a 12B IV + 16B tag + 32B key body = 60B at
    // minimum. Reject anything obviously malformed before it touches PG.
    const saltBuf = Buffer.from(b.passphrase_salt, "base64");
    const wrapBuf = Buffer.from(b.wrapped_master_key, "base64");
    if (saltBuf.length < 16 || saltBuf.length > 64) return reply.badRequest("passphrase_salt size out of range");
    if (wrapBuf.length < 40 || wrapBuf.length > 256) return reply.badRequest("wrapped_master_key size out of range");
    const sb = supabaseWithJwt(req.authJwt!);
    const { error } = await sb
      .from("user_crypto")
      .upsert({
        user_id: req.authUser!.id,
        passphrase_salt:    saltBuf,
        wrapped_master_key: wrapBuf,
        kdf_algorithm:      b.kdf_algorithm    || "argon2id",
        kdf_params:         b.kdf_params       || { opslimit: 3, memlimit: 67108864 },
        cipher_algorithm:   b.cipher_algorithm || "aes-256-gcm",
        updated_at:         new Date().toISOString(),
      });
    if (error) return reply.internalServerError(error.message);
    return reply.code(204).send();
  });
}
