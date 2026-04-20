// Direct Postgres pool — used for bytea operations (supabase-js can't handle Buffers).
import pg from "pg";
import { config } from "./config.js";

export const pgPool = config.dbUrl
  ? new pg.Pool({
      connectionString: config.dbUrl,
      max: 4,
      idleTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    })
  : null;

export function requirePool(): pg.Pool {
  if (!pgPool) throw new Error("DATABASE_URL not configured");
  return pgPool;
}
