// Direct Postgres pool — used for bytea operations (supabase-js can't handle Buffers).
import pg from "pg";
import { config } from "./config.js";

// v0.0.291 — hit a WALL with max=15 (v0.0.290 setting): Supavisor
// SESSION MODE (port 5432) caps clients-per-user at 15. Our pg.Pool
// eating all 15 left zero room for anything else (Realtime channel
// keeper, diag scripts running against the same user, transient
// sub-connections during bulk INSERT) — any 16th client attempt
// returns FATAL EMAXCONNSESSION, which surfaces as sync queries
// silently failing, sync loops hanging, and "no new mail arriving".
//
// Root fix would be to switch DATABASE_URL to TRANSACTION mode
// (port 6543, limit ~200 clients), but that needs a Fly-secret
// rotation and testing that pg-node's default query mode still
// works. For now: back off well under the session-mode ceiling.
//
// Settings:
//   max: 8                 — comfortable margin under Supavisor's
//                            session-mode limit of 15. Bootstrap's
//                            12-parallel Promise.all still runs
//                            8-at-a-time which is 2× the previous
//                            v0.0.283 baseline and doesn't queue
//                            into a stall.
//   idleTimeoutMillis: 60s — keep the pool warm; connect penalty
//                            (~3-5s from Frankfurt to eu-central-1
//                            Supavisor) only pays once per idle window.
//   keepAlive: true        — TCP keepalives against NAT idle-kills.
export const pgPool = config.dbUrl
  ? new pg.Pool({
      connectionString: config.dbUrl,
      max: 8,
      idleTimeoutMillis: 60_000,
      keepAlive: true,
      ssl: { rejectUnauthorized: false },
    })
  : null;

export function requirePool(): pg.Pool {
  if (!pgPool) throw new Error("DATABASE_URL not configured");
  return pgPool;
}
