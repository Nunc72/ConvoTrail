// Directly set a user's password via the Supabase admin API.
// Useful when the normal magic-link / forgot-password emails don't arrive
// (free-tier rate limit is 4/hour) or when we need to skip the flow during
// testing.
//
// Run via:  flyctl ssh console -C "node dist/scripts/set-password.js <email> <password>"
import { supabaseAdmin } from "../supabase.js";

const email    = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error("Usage: set-password <email> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}
if (!supabaseAdmin) {
  console.error("SUPABASE_SERVICE_KEY not set");
  process.exit(1);
}

// listUsers is paginated; the MVP userbase fits in a single page.
const { data, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
if (listErr) {
  console.error("Failed to list users:", listErr.message);
  process.exit(1);
}
const user = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`User not found: ${email}`);
  process.exit(1);
}

const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
if (error) {
  console.error("Failed to set password:", error.message);
  process.exit(1);
}

console.log(`✓ Password set for ${email} (user id: ${user.id})`);
