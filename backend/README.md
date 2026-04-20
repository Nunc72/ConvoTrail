# ConvoTrail backend

Fastify (TypeScript) API + IMAP/SMTP proxy + sync-engine.

## Local setup

```bash
cd backend
cp .env.example .env          # then fill in SUPABASE_SERVICE_KEY, DATABASE_URL, CRED_ENC_KEY
npm install
npm run dev
```

Hit http://localhost:3000/health to verify.

## Database migrations

Applied in order from `migrations/*.sql`. Tracked in `_migrations` table.

```bash
npm run migrate
```

## Deploy to Fly

```bash
fly launch --no-deploy    # first time only, reads fly.toml
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... CRED_ENC_KEY=...
fly deploy
```

## Endpoints

- `GET /health` — liveness
- (more coming: `/auth`, `/mail-accounts`, `/messages`, `/contacts`, `/tags`, `/drafts`, `/sync`, `/send`, `/search`)
