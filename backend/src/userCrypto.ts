// Server-side helpers for Pad A end-to-end encryption. The user's
// 32-byte master key arrives on every encryption-needing request via
// the X-User-Key request header (base64). The backend uses it in
// memory only — never persists it, never logs it. Algorithms + byte
// layout match the FE's CONVOOZ_CRYPTO module exactly so a Buffer
// produced here round-trips through the FE decryptBytes and a Uint8Array
// produced there round-trips through decryptForUser here.
//
//   • encryptForUser(plaintext, rawKey): [iv (12B) | ct+gcm-tag]
//     AES-256-GCM, random IV per call.
//   • blindIndexForUser(value, rawKey, context): 32-byte HMAC-SHA256
//     keyed by a context-tagged sub-key derived from the master with
//     HMAC-SHA256(rawMaster, context). value is normalized via
//     .trim().toLowerCase() to match the FE.
//
// Uses Node's globalThis.crypto.subtle (Web Crypto in Node ≥ 16). No
// extra dependency.

const subtle = globalThis.crypto.subtle;

export function parseUserKeyHeader(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const s = Array.isArray(header) ? header[0] : header;
  if (!s) return null;
  let buf: Buffer;
  try { buf = Buffer.from(s, "base64"); }
  catch { return null; }
  if (buf.length !== 32) return null;
  return buf;
}

// Buffer → fresh ArrayBuffer. The Web Crypto type signatures in
// recent @types/node insist on ArrayBufferView<ArrayBuffer>, not
// ArrayBufferView<ArrayBufferLike>, so a plain `new Uint8Array(buf)`
// trips the type-checker even though it works at runtime. Copy into
// a new ArrayBuffer to make the call site type-clean.
function bufToArrayBuffer(b: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

async function importAesKey(rawKey: Buffer): Promise<CryptoKey> {
  return await subtle.importKey(
    "raw", bufToArrayBuffer(rawKey), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function importHmacKey(rawKey: Buffer): Promise<CryptoKey> {
  return await subtle.importKey(
    "raw", bufToArrayBuffer(rawKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

export async function encryptForUser(plaintext: string | null | undefined, rawKey: Buffer): Promise<Buffer | null> {
  if (plaintext == null || plaintext === "") return null;
  const key = await importAesKey(rawKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = Buffer.alloc(iv.length + ct.byteLength);
  iv.forEach((b, i) => { out[i] = b; });
  Buffer.from(ct).copy(out, iv.length);
  return out;
}

// v0.0.272 — Tier 3 attachment encryption step 2: AES-GCM over raw
// bytes (attachment binaries). Same envelope shape as encryptForUser
// (12-byte IV prefix, GCM auth tag suffix), so the FE-side decrypt
// path the step-5 code introduces can share the existing decrypt
// helper. Returns null on empty input so callers can skip the
// Storage upload without a special check.
export async function encryptBytesForUser(plaintext: Buffer | null | undefined, rawKey: Buffer): Promise<Buffer | null> {
  if (!plaintext || plaintext.length === 0) return null;
  const key = await importAesKey(rawKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // Buffer's `buffer` may be SharedArrayBuffer in strict TS — copy
  // into a fresh Uint8Array so the WebCrypto API gets a plain
  // ArrayBufferView backed by a plain ArrayBuffer.
  const data = new Uint8Array(plaintext.byteLength);
  data.set(plaintext);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  const out = Buffer.alloc(iv.length + ct.byteLength);
  iv.forEach((b, i) => { out[i] = b; });
  Buffer.from(ct).copy(out, iv.length);
  return out;
}

export async function blindIndexForUser(value: string | null | undefined, rawKey: Buffer, context = "convooz-blind-v1"): Promise<Buffer | null> {
  if (value == null || value === "") return null;
  const normalized = value.trim().toLowerCase();
  // Sub-key derivation: HMAC(rawMaster, context) → 32-byte key bytes →
  // import as new HMAC key → sign(value) → output. Matches the FE's
  // CONVOOZ_CRYPTO.blindIndex two-step derivation.
  const masterHmac = await importHmacKey(rawKey);
  const subRaw = Buffer.from(await subtle.sign(
    { name: "HMAC" }, masterHmac, new TextEncoder().encode(context),
  ));
  const subKey = await importHmacKey(subRaw);
  return Buffer.from(await subtle.sign(
    { name: "HMAC" }, subKey, new TextEncoder().encode(normalized),
  ));
}
