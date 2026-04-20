// Usage: npm run invite -- user@example.com
// Sends a Supabase magic-link invite email. User clicks link → sets password → lands in app.
import { supabaseAdmin } from "./supabase.js";

const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.error("Usage: npm run invite -- user@example.com");
  process.exit(1);
}

if (!supabaseAdmin) {
  console.error("SUPABASE_SERVICE_KEY not set in .env");
  process.exit(1);
}

const redirectTo = process.env.INVITE_REDIRECT_URL || "https://nunc72.github.io/ConvoTrail/";

const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });
if (error) {
  console.error(`Failed to invite ${email}: ${error.message}`);
  process.exit(1);
}

console.log(`✓ Invite sent to ${email}`);
console.log(`  User id: ${data.user?.id}`);
console.log(`  They will receive an email and land at: ${redirectTo}`);
