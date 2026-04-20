import type { FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "./supabase.js";

export interface AuthUser {
  id: string;
  email: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    authJwt?: string;
  }
}

// ── Simple in-memory JWT cache ──────────────────────────────────────────────
// Skip the Supabase Auth round-trip when a JWT has been validated recently.
// Tradeoff: if a user signs out server-side, their token stays "valid" for up
// to TTL ms on this backend. Acceptable for MVP; tighten later if needed.
interface CacheEntry { user: AuthUser; expiresAt: number; }
const jwtCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 2000;

function cacheGet(jwt: string): AuthUser | null {
  const e = jwtCache.get(jwt);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { jwtCache.delete(jwt); return null; }
  return e.user;
}
function cacheSet(jwt: string, user: AuthUser) {
  if (jwtCache.size >= CACHE_MAX) jwtCache.clear();
  jwtCache.set(jwt, { user, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function authPreHandler(req: FastifyRequest, reply: FastifyReply) {
  const hdr = req.headers.authorization;
  if (!hdr || !hdr.startsWith("Bearer ")) {
    return reply.unauthorized("Missing bearer token");
  }
  const jwt = hdr.slice(7);

  const cached = cacheGet(jwt);
  if (cached) {
    req.authUser = cached;
    req.authJwt = jwt;
    return;
  }

  if (!supabaseAdmin) {
    return reply.internalServerError("Auth not configured (SUPABASE_SERVICE_KEY missing)");
  }
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) {
    return reply.unauthorized("Invalid or expired token");
  }
  const user: AuthUser = { id: data.user.id, email: data.user.email ?? null };
  cacheSet(jwt, user);
  req.authUser = user;
  req.authJwt = jwt;
}
