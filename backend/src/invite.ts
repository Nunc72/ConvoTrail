// Usage:  node dist/invite.js [--days 14]
//
// Creates an invite row with a short uppercase code and prints the code.
// Share the code via WhatsApp/SMS/etc. together with the homepage URL; the
// tester clicks Create account on the login screen and pastes the code in
// the form. Supabase auth emails are bypassed entirely.
import { randomInt } from "node:crypto";
import { requirePool } from "./db.js";

const args = process.argv.slice(2);
const daysIx = args.indexOf("--days");
const expireDays = daysIx >= 0 && args[daysIx + 1] ? Number(args[daysIx + 1]) : 14;

if (!Number.isFinite(expireDays) || expireDays <= 0) {
  console.error(`Invalid --days: ${args[daysIx + 1]}`);
  process.exit(1);
}

// 8 chars from an unambiguous alphabet — no 0/O, 1/I/L. ~1.1e12 combinations,
// plenty for a private testing phase without rate limits.
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CHARSET[randomInt(0, CHARSET.length)];
  return s;
}

const pool = requirePool();
// Retry a few times on the (extremely unlikely) PK collision
let token = "";
for (let attempt = 0; attempt < 5; attempt++) {
  token = makeCode();
  try {
    await pool.query(
      `INSERT INTO invites (token, email, expires_at)
         VALUES ($1, NULL, now() + ($2 || ' days')::interval)`,
      [token, String(expireDays)],
    );
    break;
  } catch (e: unknown) {
    if (attempt === 4) throw e;
  }
}
await pool.end();

console.log(`✓ Invite code: ${token}`);
console.log(`  Expires in ${expireDays} days, single use.`);
console.log("");
console.log("Share with the tester:");
console.log("  Convooz: https://nunc72.github.io/ConvoTrail/");
console.log(`  Code: ${token}`);
