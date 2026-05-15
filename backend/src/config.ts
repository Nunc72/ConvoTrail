import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "3000")),
  host: optional("HOST", "0.0.0.0"),
  // Restrictive default: only the production GitHub Pages origin and the
  // local Vite preview port are allowed. Override via CORS_ORIGIN
  // (comma-separated) if more origins ever need access. Switching the
  // default away from "*" closes the door on random sites that try to
  // call /bootstrap with a leaked JWT.
  corsOrigin: optional("CORS_ORIGIN", "https://nunc72.github.io,http://localhost:4321"),

  // Supabase
  supabaseUrl: required("SUPABASE_URL"),
  supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",

  // Postgres direct connection (for migrations)
  dbUrl: process.env.DATABASE_URL ?? "",

  // Master key for encrypting IMAP credentials at rest (AES-256)
  credEncKey: process.env.CRED_ENC_KEY ?? "",
};
