// Usage:  node dist/invite.js user@example.com [--days 14]
//
// Creates a row in the `invites` table with a random token and prints a link
// that you email to the tester. When they click the link they land on the
// ConvoTrail signup flow with their email pre-filled; they set a password,
// their IMAP account, and the first sync runs while they watch the progress
// bar. Supabase auth emails are bypassed entirely (free tier limit = 4/hour).
import { randomBytes } from "node:crypto";
import { requirePool } from "./db.js";

const args = process.argv.slice(2);
const email = args.find(a => a.includes("@"));
const daysIx = args.indexOf("--days");
const expireDays = daysIx >= 0 && args[daysIx + 1] ? Number(args[daysIx + 1]) : 14;

if (!email) {
  console.error("Usage: invite <user@example.com> [--days 14]");
  process.exit(1);
}
if (!Number.isFinite(expireDays) || expireDays <= 0) {
  console.error(`Invalid --days: ${args[daysIx + 1]}`);
  process.exit(1);
}

const frontendBase = process.env.INVITE_REDIRECT_URL || "https://nunc72.github.io/ConvoTrail/";
const token = randomBytes(24).toString("base64url"); // 32 chars, URL-safe

const pool = requirePool();
await pool.query(
  `INSERT INTO invites (token, email, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
  [token, email.toLowerCase(), String(expireDays)],
);
await pool.end();

const url = `${frontendBase}${frontendBase.includes("?") ? "&" : "?"}invite=${token}`;

console.log(`✓ Invite created for ${email}`);
console.log(`  Expires in ${expireDays} days`);
console.log(`  Token: ${token}`);
console.log("");
console.log("Email this link to the tester:");
console.log(`  ${url}`);
console.log("");
console.log("Suggested email body:");
console.log("  ────────────────────────────────────────────");
console.log(`  Hi,`);
console.log("");
console.log("  Je bent uitgenodigd om ConvoTrail te testen — een conversation-");
console.log("  centric e-mail client. Klik de link hieronder om je account aan");
console.log("  te maken en je IMAP/SMTP-mailaccount te koppelen:");
console.log("");
console.log(`  ${url}`);
console.log("");
console.log(`  De link is ${expireDays} dagen geldig en eenmalig bruikbaar.`);
console.log("");
console.log("  Vragen? Mail me terug.");
console.log("  ────────────────────────────────────────────");
