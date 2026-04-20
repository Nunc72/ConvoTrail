import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Anon client — subject to RLS, used for user-scoped operations with a user JWT
export const supabaseAnon: SupabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Service-role client — bypasses RLS. USE ONLY FOR ADMIN OPERATIONS.
export const supabaseAdmin: SupabaseClient | null = config.supabaseServiceKey
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Build a user-scoped client from a JWT (reads subject to that user's RLS)
export function supabaseWithJwt(jwt: string): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
