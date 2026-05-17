import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { config } from "./config.js";

// ─── Shared keep-alive HTTP dispatcher ────────────────────────────────
// supabase-js builds a brand-new client per request (supabaseWithJwt
// below) because each request carries its own user JWT in the global
// Authorization header. Out of the box every new client opens a fresh
// TCP+TLS connection to Supabase REST — from our Fly machine in
// Frankfurt that costs 3-5s of handshake on the cold path before any
// query has even run. /bootstrap fires ~10 of those in parallel, which
// is exactly how requests started piling up against Undici's ~25s
// inactivity timeout and returning "TypeError: fetch failed".
//
// One shared Undici Agent fixes this: every supabase client routes its
// fetch through the same dispatcher, which pools TCP+TLS connections
// across users and routes. Subsequent calls re-use an already-warm
// connection (50-100ms), and the cold-start cost is paid once per
// machine boot instead of once per /bootstrap.
const sbDispatcher = new Agent({
  // Force HTTP/1.1 over the pool. undici 8 negotiates HTTP/2 with Supabase
  // when ALPN allows it (Supabase's edge gateway speaks h2), and the
  // resulting ClientHttp2Stream then occasionally stalls indefinitely
  // — observed in prod as 60s "stream timeout" hangs on
  // supabaseAdmin.auth.admin.getUserById that surface as a "No account
  // with that username" 404 in the FE. HTTP/1.1 with keep-alive keeps
  // the connection-pooling win (skip the 3-5s cold TLS handshake from
  // Fly to Supabase) without the HTTP/2 stream lifecycle bugs.
  allowH2: false,
  // Idle connection retention. Shorter than before so a half-broken
  // socket that survives a network blip won't be reused for minutes
  // before discovery. 15s is well within the inter-request gap of an
  // active session yet short enough to cycle dead connections quickly.
  keepAliveTimeout: 15_000,
  keepAliveMaxTimeout: 60_000,
  // Cap the number of connections per host so a burst doesn't
  // accidentally DoS Supabase's pgrest.
  connections: 32,
  // Aggressive per-request deadlines: a hung request shouldn't tie up
  // a worker for a full minute. If Supabase actually needs more than
  // 15s to start replying something is genuinely wrong and we want
  // the error fast so the FE can retry / show a clean 503.
  headersTimeout: 15_000,
  bodyTimeout: 30_000,
  // If the TLS+TCP connect itself takes more than 8s we should give
  // up and retry rather than waiting on a dead-looking link.
  connect: { timeout: 8_000 },
});

// supabase-js expects a fetch with the global Fetch API signature, but
// undici's fetch has its own (compatible) types. The cast lets the
// supabase-js client typings line up without leaking undici types out.
const sharedFetch: typeof fetch = ((input: unknown, init?: unknown) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as UndiciRequestInit),
    dispatcher: sbDispatcher,
  })) as unknown as typeof fetch;

// Anon client — subject to RLS, used for user-scoped operations with a user JWT
export const supabaseAnon: SupabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: sharedFetch },
});

// Service-role client — bypasses RLS. USE ONLY FOR ADMIN OPERATIONS.
export const supabaseAdmin: SupabaseClient | null = config.supabaseServiceKey
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: sharedFetch },
    })
  : null;

// Build a user-scoped client from a JWT (reads subject to that user's RLS)
export function supabaseWithJwt(jwt: string): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: sharedFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
