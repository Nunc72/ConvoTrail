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
import { requirePool } from "../db.js";

interface CryptoBody {
  passphrase_salt: string;     // base64
  wrapped_master_key: string;  // base64
  kdf_algorithm?: string;
  kdf_params?: Record<string, unknown>;
  cipher_algorithm?: string;
}

// Both GET and PUT bypass supabase-js for the BYTEA columns. The
// supabase-js client JSON-serialises a Node Buffer as
// {"type":"Buffer","data":[...]}, which PostgREST happily stored as
// 146 bytes of JSON inside the salt column — not the raw 32-byte salt
// we wanted. Direct pg-pool binding takes a Buffer and writes the
// underlying bytes verbatim, which is the only way to get the
// round-trip right.
export async function registerUserCryptoRoutes(app: FastifyInstance) {
  const auth = { preHandler: authPreHandler };

  app.get("/me/crypto", auth, async (req, reply) => {
    const pool = requirePool();
    const r = await pool.query<{
      passphrase_salt: Buffer;
      wrapped_master_key: Buffer;
      kdf_algorithm: string;
      kdf_params: Record<string, unknown>;
      cipher_algorithm: string;
    }>(
      `SELECT passphrase_salt, wrapped_master_key, kdf_algorithm, kdf_params, cipher_algorithm
         FROM user_crypto WHERE user_id = $1`,
      [req.authUser!.id],
    );
    // 200 in both branches so the FE only has to look at status, not
    // catch a 404. `status: 'unset'` is the signal to run the setup-
    // passphrase flow.
    if (r.rows.length === 0) return { status: "unset" };
    const row = r.rows[0];
    return {
      status:             "locked",
      passphrase_salt:    row.passphrase_salt.toString("base64"),
      wrapped_master_key: row.wrapped_master_key.toString("base64"),
      kdf_algorithm:      row.kdf_algorithm,
      kdf_params:         row.kdf_params,
      cipher_algorithm:   row.cipher_algorithm,
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
    const pool = requirePool();
    await pool.query(
      `INSERT INTO user_crypto (user_id, passphrase_salt, wrapped_master_key,
                                kdf_algorithm, kdf_params, cipher_algorithm)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (user_id) DO UPDATE
         SET passphrase_salt = EXCLUDED.passphrase_salt,
             wrapped_master_key = EXCLUDED.wrapped_master_key,
             kdf_algorithm = EXCLUDED.kdf_algorithm,
             kdf_params = EXCLUDED.kdf_params,
             cipher_algorithm = EXCLUDED.cipher_algorithm,
             updated_at = now()`,
      [
        req.authUser!.id,
        saltBuf,
        wrapBuf,
        b.kdf_algorithm    || "pbkdf2-sha256",
        JSON.stringify(b.kdf_params || { iterations: 600000, hash: "SHA-256" }),
        b.cipher_algorithm || "aes-256-gcm",
      ],
    );
    return reply.code(204).send();
  });
}
