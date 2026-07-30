// Direct Postgres pool — used for bytea operations (supabase-js can't handle Buffers).
import pg from "pg";
import { config } from "./config.js";

// v0.0.290 — pool sizing was strangling us. max=4 meant /bootstrap's
// 12-parallel Promise.all serialised into three waves, and idleTimeout
// = 10s meant a warm pool went cold between the bootstrap fetch and
// the first user action. Each fresh connect against the Supavisor
// pooler takes ~3-5s from Frankfurt (measured — normal is <200ms,
// suspected regional Supavisor congestion), so cold restarts made the
// user experience "Sending…" for tens of seconds.
//
// New settings:
//   max: 15                — plenty of headroom for parallel bootstrap
//                            + concurrent /send + /sync. Supabase Pro
//                            allows ~60 pool clients per project.
//   idleTimeoutMillis: 60s — keep the pool warm between user actions.
//                            The connect penalty only pays once per
//                            minute at most.
//   keepAlive: true        — TCP keepalives so NAT/router idle-kills
//                            can't silently drop a still-open socket
//                            (which would surface as a mysterious
//                            first-query timeout after a quiet spell).
export const pgPool = config.dbUrl
  ? new pg.Pool({
      connectionString: config.dbUrl,
      max: 15,
      idleTimeoutMillis: 60_000,
      keepAlive: true,
      ssl: { rejectUnauthorized: false },
    })
  : null;

export function requirePool(): pg.Pool {
  if (!pgPool) throw new Error("DATABASE_URL not configured");
  return pgPool;
}
