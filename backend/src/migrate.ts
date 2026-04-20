import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

if (!config.dbUrl) {
  console.error("DATABASE_URL not set. Put it in backend/.env or export it before running.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: config.dbUrl });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const applied = new Set(
  (await client.query<{ name: string }>("SELECT name FROM _migrations")).rows.map((r) => r.name),
);

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

for (const f of files) {
  if (applied.has(f)) {
    console.log(`✓ ${f} (already applied)`);
    continue;
  }
  const sql = readFileSync(join(migrationsDir, f), "utf8");
  console.log(`→ applying ${f} ...`);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO _migrations(name) VALUES ($1)", [f]);
    await client.query("COMMIT");
    console.log(`✓ ${f}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`✗ ${f}: ${(e as Error).message}`);
    process.exit(1);
  }
}

await client.end();
console.log("Migrations complete.");
