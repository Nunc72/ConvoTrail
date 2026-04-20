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
  corsOrigin: optional("CORS_ORIGIN", "*"),

  // Supabase
  supabaseUrl: required("SUPABASE_URL"),
  supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",

  // Postgres direct connection (for migrations)
  dbUrl: process.env.DATABASE_URL ?? "",

  // Master key for encrypting IMAP credentials at rest (AES-256)
  credEncKey: process.env.CRED_ENC_KEY ?? "",
};
