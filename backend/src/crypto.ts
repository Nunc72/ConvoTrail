// AES-256-GCM encryption for credentials at rest.
// Output layout: [ iv (12B) | tag (16B) | ciphertext ]
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

const KEY = Buffer.from(config.credEncKey, "base64");
if (config.credEncKey && KEY.length !== 32) {
  throw new Error(`CRED_ENC_KEY must be 32 bytes (base64) — got ${KEY.length}`);
}

export function encrypt(plaintext: string): Buffer {
  if (KEY.length !== 32) throw new Error("CRED_ENC_KEY not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(buf: Buffer): string {
  if (KEY.length !== 32) throw new Error("CRED_ENC_KEY not configured");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
