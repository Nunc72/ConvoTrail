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

export async function authPreHandler(req: FastifyRequest, reply: FastifyReply) {
  const hdr = req.headers.authorization;
  if (!hdr || !hdr.startsWith("Bearer ")) {
    return reply.unauthorized("Missing bearer token");
  }
  const jwt = hdr.slice(7);
  if (!supabaseAdmin) {
    return reply.internalServerError("Auth not configured (SUPABASE_SERVICE_KEY missing)");
  }
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) {
    return reply.unauthorized("Invalid or expired token");
  }
  req.authUser = { id: data.user.id, email: data.user.email ?? null };
  req.authJwt = jwt;
}
