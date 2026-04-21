# ConvoTrail — handover

_Last updated: 2026-04-21, v0.0.35_

A conversation-centric email client. Mail stays on IMAP (Gmail/iCloud/own);
ConvoTrail adds grouping per contact, tags, revert-to-me, merge/unmerge,
and a shared-across-devices UI on top of existing mailboxes.

## Live endpoints

| Thing | URL / name |
|---|---|
| Frontend (PWA) | https://nunc72.github.io/ConvoTrail/ |
| Backend API    | https://convotrail-backend-nunc72.fly.dev |
| Repo           | https://github.com/Nunc72/ConvoTrail |
| Supabase proj  | https://supabase.com/dashboard/project/oyrlzqbjcsliesvunbwj |
| Fly app        | `convotrail-backend-nunc72` (org `ZumoCreations`, Frankfurt) |

## Stack

- **Frontend**: single-file React 18 (via CDN) + Tailwind (via CDN) + Babel-standalone. `mockup-v4.html` is the app; `index.html` auto-routes desktop→phone-frame preview, phone→direct. No build step. Hosted on GitHub Pages from `main`.
- **Backend**: Node.js 22 + Fastify 5 (TypeScript, ESM). Entry `backend/src/server.ts`. Built with `tsc` into `dist/`. Dockerized for Fly (Alpine base, multi-stage build). 2 shared-cpu-1x machines, 512 MB, auto-stop when idle.
- **Database + Auth**: Supabase (Postgres 15 + Auth). Free tier until growth. Migrations in `backend/migrations/*.sql`, run via `npm run migrate`. Row-Level Security active on all user-owned tables (policy: `user_id = auth.uid()`).
- **Mail protocols**: IMAP via `imapflow`, parsing via `mailparser`, SMTP via `nodemailer` (planned).
- **Secrets**: Fly secrets for prod (`fly secrets list --app convotrail-backend-nunc72`); `backend/.env` locally (gitignored). Never commit `.env`.

## Credentials we hold

| Secret | Where | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Fly secret + frontend (public) | Anon key is safe in frontend — RLS does the work |
| `SUPABASE_SERVICE_KEY` | Fly secret only | JWT verification, admin ops (invite, set-password). **Rotate if leaked.** |
| `DATABASE_URL` | Fly secret | Postgres direct via Supabase session pooler |
| `CRED_ENC_KEY` | Fly secret only | 32-byte base64, used for AES-256-GCM of IMAP/SMTP passwords. **Never rotate without re-encrypting all creds** — users would have to re-enter mail passwords. |

## Users

- Signup is **invite-only**. Disable "Allow new users to sign up" in Supabase Auth settings.
- Admin (`rik@tuithof.com`) was bootstrapped via admin API. Current password: see password manager.
- To invite: in `backend/`, run `npm run invite -- user@example.com`. Supabase sends a magic-link email; the user lands in ConvoTrail authenticated with no password set. **Known gap**: user must then go through Forgot-password flow to set one. Planned fix: detect this state and prompt "set a password" automatically.
- Supabase free email rate limit: **4/hour, 30/day**. Plenty for testing, but beyond ~3 parallel new invites you'll hit it. Workaround: admin sets password directly via admin API (there's a one-off `setpw.ts` pattern in git history — write a `npm run set-password` script when routinely needed), or configure external SMTP (Resend) in Supabase Auth.

## Local dev

```bash
git clone git@github.com:Nunc72/ConvoTrail.git
cd ConvoTrail/backend

# Once
cp .env.example .env     # fill SUPABASE_SERVICE_KEY, DATABASE_URL, CRED_ENC_KEY
npm install
npm run build            # compiles TS into dist/

# Common
npm run dev              # tsx watch, live reload
npm run migrate          # apply pending SQL migrations
npm run invite -- x@y.z  # invite a user
```

Node 22+ (via nvm). `flyctl` at `~/.fly/bin/flyctl`.

**macOS gotcha**: files written by Claude Code into `~/Documents/` sometimes get a `com.apple.provenance` xattr that blocks `mv` from the user's shell even though the same shell could `cd`/`ls`. Workaround: `rm` + re-create via editor, or use Claude Code's Bash tool.

## Deploy

**Frontend** is auto-deployed by GitHub Pages on every push to `main`. The `version.json` + `APP_VERSION` in `mockup-v4.html` should both be bumped on every commit. Users click the version row in the user menu to force a cold-load via `?v=<new>` query string.

**Backend** deploys manually with `flyctl deploy --app convotrail-backend-nunc72` (from `backend/`). Secrets stay on Fly; only code changes ship. ~60 s end-to-end.

**DB migrations**: run `npm run migrate` with `DATABASE_URL` pointing to the session pooler (port 5432). New migrations go in `backend/migrations/`, numbered `NNNN_description.sql`. The runner is idempotent and tracks applied names in `_migrations`.

## Workflow

- Commit-per-feature. Bump `APP_VERSION` + `version.json` on every commit pushed to main.
- Claude Code sessions work on a worktree under `.claude/worktrees/<name>/`, branch `claude/<name>`. Fast-forward merge into `main` before push.
- After deploying backend: smoke-test `/health`.
- After frontend push: wait ~30–60 s for Pages build, then user can click version row in user menu to reload.

## Non-obvious things to remember

- **Supabase session pooler hostname** for this project is `aws-1-eu-central-1.pooler.supabase.com:5432`. The "direct" DB hostname (`db.<ref>.supabase.co`) does not resolve on the free tier. Username format: `postgres.<project-ref>`.
- **Supabase bytea is broken via supabase-js**: `supabase.from(...).insert({ col: buffer })` serializes the Buffer as `{"type":"Buffer","data":[...]}` JSON and stores that *literal text*'s bytes. For any `bytea` column, use `pg` directly via `backend/src/db.ts` (`requirePool()`).
- **Fastify 5 rejects empty body with `Content-Type: application/json`**. The frontend `apiFetch` helper intentionally only adds that header when `opts.body` is present. Don't re-introduce an always-on Content-Type.
- **JWT cache** lives in-process in the backend (`backend/src/auth.ts`), 60 s TTL. If you sign a user out and they hit a warm backend within 60 s, their old JWT still works. Tradeoff is perf; revisit if security tightens.
- **Fly auto-stop**: VMs sleep when idle to save €. First request after >5 min pauses pays a 1–3 s cold start. Flip `min_machines_running = 1` in `fly.toml` to avoid, ~€1–2/m extra.
- **Gmail** needs OAuth2; not wired yet (planned). **iCloud** needs an app-specific password — there's a hint in the Mail Accounts modal.
- **Retention**: spec says deleted messages are hard-purged after 90 days (DB + IMAP EXPUNGE). Not yet implemented.

## Data model (high level)

All user-scoped via RLS. See `backend/migrations/0001_initial_schema.sql` for the full schema.

```
auth.users                        (managed by Supabase)
  │
  └─ mail_accounts                1 user : N accounts (2-3 per user typical)
        │                         bytea creds for IMAP/SMTP (AES-256-GCM)
        └─ messages               cached from IMAP, dedup on (account, folder, uid, uidvalidity)

  └─ contacts                     1 user : N contacts (auto-extracted on sync)
        └─ contact_emails         one contact can have multiple addresses
        └─ contact_tags           (tags for contacts)

  └─ tags                         1 user : N tags
        └─ message_tags           (tags for messages)

  └─ drafts                       synced across devices (planned)
  └─ signatures / account_signatures
  └─ r2m_state                    (revert-to-me timers)
  └─ invites                      (invite tokens for signup)
```

## Where to look

| Concern | File |
|---|---|
| API route definitions | `backend/src/routes/*.ts` |
| Sync engine | `backend/src/sync.ts` |
| Crypto | `backend/src/crypto.ts` |
| IMAP client helpers | `backend/src/imap.ts` |
| Direct Postgres pool (bytea) | `backend/src/db.ts` |
| Supabase clients (anon/admin/JWT) | `backend/src/supabase.ts` |
| JWT verification middleware | `backend/src/auth.ts` |
| Config / env vars | `backend/src/config.ts` |
| Migrations | `backend/migrations/` |
| Frontend single-file app | `mockup-v4.html` |
| Feature roadmap | `FEATURES.md` |

## Recent history (terse)

- v0.0.35 — fix: r2mDays=0 still got rewritten to 3 on shape + ContactEditForm useState (both still used `|| 3` — swapped to `?? 3`)
- v0.0.34 — Reply all + Forward buttons wired (new handleReplyAll / handleForward + replyKind state); ComposePane CC auto-filled for reply-all
- v0.0.33 — fix: Contact edit r2m_days=0 was silently replaced with 3 (`|| 3` treats 0 as falsy)
- v0.0.32 — Outgoing sender uses mail-account display_name (avatars, thread lists, quote headers); "(no body text)" placeholder; involvedEmails uses real mailAccounts
- v0.0.31 — Revert2me is a second Send button (not a toggle); r2m auto-suppressed when a reply exists in the same RFC thread
- v0.0.30 — Revert2Me persisted (r2m_state); compose Revert2Me toggles arming on send; r2m_days now allows 0 (instant) for testing
- v0.0.29 — Contact edit persist: name/org/r2m_days/primary_email via PATCH /contacts/:id (Tier 1.9)
- v0.0.28 — News/Mute per contact (not per address) + Archive persisted; tag email-roles persisted to tags.email_roles JSONB; migration 0003
- v0.0.27 — fix: tags list was empty because usedTags did `Number(msgId)` on UUID message ids
- v0.0.26 — message tags persisted (tags + message_tags via /bootstrap; POST/DELETE /messages/:id/tags with create-or-get by name)
- v0.0.25 — mail-account detail: retention dropdowns (deleted/spam) + auto-sync checkbox + shorter Test/Sync buttons; migration 0002
- v0.0.24 — soft-delete persisted (PATCH /messages/:id/delete + /recover); bootstrap hydrates deletedIds from deleted_at
- v0.0.23 — drop auto-mark-read on open (mark-read via Seen/Snooze buttons only, per design)
- v0.0.22 — fix CORS: allow PATCH/PUT/DELETE methods (fixes mark-read + mail-account edit + draft-save from browser)
- v0.0.21 — mark-read persisted (PATCH /messages/:id/flags, IMAP \Seen + DB) + auto-mark-read on open
- v0.0.20 — fix duplicate Sent row: APPEND uses SPECIAL-USE `\Sent` path (same as sync)
- v0.0.19 — drafts persist (CRUD + /bootstrap) + per-contact active-message memory
- v0.0.18 — mail send (SMTP via nodemailer + IMAP APPEND to Sent)
- v0.0.17 — Settings → Mail accounts: master-detail UI + PATCH /mail-accounts/:id
- v0.0.16 — move Mail accounts under Settings → Mail accounts tab
- v0.0.15 — persist unmerge-email
- v0.0.14 — persist contact merge
- v0.0.13 — add HANDOVER.md + FEATURES.md
- v0.0.12 — filter messages + per-contact counts by selected accounts
- v0.0.11 — real mail accounts in left-column switcher (replaces hardcoded USER_ACCOUNTS)
- v0.0.10 — JWT cache (60 s) + `/bootstrap` combined endpoint (perf)
- v0.0.9 — wire real contacts + messages into main UI (was mockup data)
- v0.0.8 — pg-direct for bytea (supabase-js Buffer serialization bug)
- v0.0.7 — apiFetch: don't send Content-Type on empty-body POSTs
- v0.0.6 — IMAP sync engine + in-modal message preview
- v0.0.5 — mail-account CRUD + IMAP connection test
- v0.0.4 — wire real auth (Supabase)
- v0.0.3 — backend skeleton (Fastify + Postgres migrations)
- v0.0.2 — version display + click-to-update check
- v0.0.1 — chronological sort fix for drafts

See `git log` for details. Each commit message explains *why*.
