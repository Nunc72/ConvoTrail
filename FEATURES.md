# ConvoTrail — feature roadmap

_Last updated: 2026-04-20, v0.0.13_

Status legend:
- ✅ **Done** — works end-to-end, persists where relevant
- 🚧 **Partial** — UI exists but mutations don't persist, or mock-only
- ⬜ **Not started**
- 🔒 **Blocked / decision pending**

Source of truth for what still needs to happen. `HANDOVER.md` covers infra;
this doc covers product.

---

## Current snapshot (what actually works)

**Real + persisted**
- ✅ Auth: signup (invite-only), login, logout, forgot-password, set-password
- ✅ Mail account management: add, test IMAP connection, save (AES-256-GCM creds), delete, list, manual sync trigger, per-account preview of synced subjects
- ✅ IMAP sync: INBOX + Sent, last 90 days, cap 100 msgs/folder, dedup on UID, extracts contacts from from/to addresses automatically
- ✅ Main UI: contacts list, per-contact thread, message detail — all driven by real data
- ✅ Left-column account switcher: toggle/combine real accounts; contact list, message list, and per-contact unread/r2m badges all filter by selection
- ✅ Client-side search across loaded messages
- ✅ Filter tabs (Now/All/In/Out/Draft/Deleted)
- ✅ Version banner + click-to-check-for-update

**UI works but mutations don't persist** (lost on refresh)
- 🚧 Mark as read / unread
- 🚧 Revert-to-me dismiss / snooze / seen
- 🚧 Tags on messages (add/remove)
- 🚧 Tags on contacts (add/remove)
- 🚧 Tag rename / archive
- 🚧 Tag roles (To / CC per email address)
- 🚧 News / Mute flags per email address
- 🚧 Contact edit (name, org, color, r2m_days)
- 🚧 Contact merge / unmerge
- 🚧 Contact archive
- 🚧 Delete message (soft delete — state only)
- 🚧 Recover from deleted
- 🚧 Spam (routes through delete state)
- 🚧 Compose message (new / reply / reply-all / forward)
- 🚧 Save draft
- 🚧 Send (no SMTP wired)
- 🚧 Signatures CRUD + per-account auto-sig

**Not implemented at all**
- ⬜ Attachment view / download
- ⬜ Attachment upload in compose
- ⬜ Automatic / scheduled sync (only manual)
- ⬜ IMAP IDLE real-time push
- ⬜ Multi-folder support beyond INBOX + Sent
- ⬜ Gmail OAuth
- ⬜ Progressive search (IMAP SEARCH for older archive)
- ⬜ Retention cleanup (90d → IMAP EXPUNGE)
- ⬜ Conversation threading (messages grouped vs. flat)
- ⬜ Rich-text compose editor
- ⬜ Undo send / scheduled send
- ⬜ Keyboard shortcuts
- ⬜ Push notifications (Web Push)
- ⬜ Admin dashboard (invites, users, stats)
- ⬜ Custom SMTP for auth emails (Resend)
- ⬜ 2FA
- ⬜ Account deletion / data export (GDPR)
- ⬜ Monitoring / error reporting
- ⬜ CI/CD pipeline
- ⬜ Automated tests

---

## Tier 1 — MVP persist (make mutations real)

Turns in-memory actions into durable ones. Highest value for daily usability.

**Active prioritized order** (per 2026-04-20 conversation):

1. 🚧 **1.1 — Real accounts in column 1, switch/combine** → ✅ shipped v0.0.11–0.0.12
2. ⬜ **1.2 — Contact merge persisted** ← *next*
3. ⬜ **1.3 — Mail Send (SMTP + IMAP APPEND to Sent)**
4. ⬜ **1.4 — Save draft persisted + active-message-per-contact memory**
5. ⬜ **1.5 — Mark-read persisted** (flags.seen → IMAP \\Seen + DB)
6. ⬜ **1.6 — Delete persisted** (soft-delete in DB, IMAP EXPUNGE via retention cron)
7. ⬜ **1.7 — Tags on messages** (CRUD + persist)
8. ⬜ **1.8 — Tags on contacts** (CRUD + persist)
9. ⬜ **1.9 — Contact edit (name/org/color/r2m_days)** persist
10. ⬜ **1.10 — Automatic sync** (poll per 2 min + on window focus)
11. ⬜ **1.11 — Onboarding nudge**: after login with zero accounts, open Add-account flow

### Per-item rough plan

**1.2 Contact merge** (½ day)
- Backend: `POST /contacts/:keepId/merge { discardId }` — move `contact_emails` to keep, merge `contact_tags`, delete discard. Transactional.
- Frontend: wire existing merge UI to API; refresh data after success.

**1.3 Send** (1 day)
- Backend: `POST /mail-accounts/:id/send { to, cc, bcc, subject, body, reply_to_message_id, signature_id }` — decrypt SMTP creds, build MIME via `nodemailer`, send, IMAP APPEND to Sent (best-effort). Insert a `messages` row with `direction='out'` and the new UID.
- Frontend: wire Send button in Compose; success toast; clear draft.

**1.4 Drafts** (½ day)
- Backend: `/drafts` CRUD (POST/PATCH/DELETE, GET via bootstrap).
- Frontend: on "Save draft", POST or PATCH; on close without save, nothing persisted. Remember last-opened message per contact in client state (Map).

**1.5 Mark-read** (½ day)
- Backend: `PATCH /messages/:id/flags { seen: true }` → update DB + IMAP `\Seen`.
- Frontend: optimistic update, revert on error.
- Auto-mark-read on open (configurable later).

**1.6 Delete** (½ day)
- Backend: `PATCH /messages/:id/delete` → set `deleted_at = now()` in DB. Schedule IMAP EXPUNGE via cron after 90d.
- Frontend: move to "Deleted" state, support Recover within window.

**1.7 Tags on messages** (1 day)
- Backend: `GET /tags`, `POST /tags { name }`, `POST /messages/:id/tags { tag_id }`, `DELETE /messages/:id/tags/:tag_id`.
- Return tag list via `/bootstrap`.
- Frontend: replace in-memory `msgTags` with real data; optimistic ops.

**1.8 Tags on contacts** (½ day) — same pattern as 1.7.

**1.9 Contact edit** (½ day)
- Backend: `PATCH /contacts/:id`.
- Frontend: save from edit modal, refresh.

**1.10 Automatic sync** (½ day)
- Frontend: `setInterval(sync, 2 * 60_000)` + `window.addEventListener('focus', sync)`.
- Careful: debounce, skip if a sync is in flight.
- Later: backend-side cron for users who don't have the tab open.

**1.11 Onboarding nudge** (¼ day)
- If `mailAccounts.length === 0` after bootstrap, auto-open MailAccountsModal with form expanded.

**Total Tier 1 remaining**: ~1 week active work.

---

## Tier 2 — Beta-ready (for 3-4 test users)

Makes the app feel polished and complete enough for friendly testers.

- ⬜ **2.1 Attachments** (2 days) — download inline + list; compose upload + chip UI (already in mockup, needs backend: `/messages/:id/attachments/:idx` to stream, `/drafts/:id/attachments` to POST).
- ⬜ **2.2 Conversation threading** (1 day) — group by `thread_id` (from In-Reply-To/References).
- ⬜ **2.3 Gmail OAuth** (1 day) — Google Cloud project + OAuth consent screen + backend OAuth flow + refresh-token handling.
- ⬜ **2.4 Progressive search** (2 days) — Postgres FTS for synced range, IMAP SEARCH for older archive, stream results via SSE, spinner + "all done" signal.
- ⬜ **2.5 Retention cleanup** (½ day) — cron: `deleted_at > 90d ago` → IMAP `\Deleted` + EXPUNGE + DB purge.
- ⬜ **2.6 r2m backend state** (1 day) — dismiss/snooze/count persisted in `r2m_state`.
- ⬜ **2.7 Signatures** (½ day) — CRUD + per-account auto-apply.
- ⬜ **2.8 News/Mute flags** (¼ day) — persist per-address.
- ⬜ **2.9 Drafts/Trash/Spam folder detection** (½ day) — sync those IMAP folders too.

Total Tier 2: ~2 weeks.

---

## Tier 3 — Scale to 20 users

- ⬜ **3.1 Admin dashboard**: invite tokens, user list, usage stats (1 day)
- ⬜ **3.2 Custom SMTP** (Resend free 3k/m) for Supabase Auth emails — fixes rate limit (½ day)
- ⬜ **3.3 Backend warm machine** (`min_machines_running = 1`) + monitoring (Fly alerts) (½ day)
- ⬜ **3.4 Push notifications** (PWA Web Push) — new mail, r2m reminder (2 days)
- ⬜ **3.5 CI/CD** (GitHub Actions: test + deploy on push to main) (½ day)
- ⬜ **3.6 Error monitoring** (Sentry free tier, both FE + BE) (¼ day)
- ⬜ **3.7 Performance** — query-tuning, paginering "load more", maybe Redis cache for hot sessions (2 days)
- ⬜ **3.8 Password change + account delete** (GDPR export) (½ day)
- ⬜ **3.9 2FA** (TOTP via Supabase Auth) (½ day)

Total Tier 3: ~1 week + sensible spacing for monitoring/iterations.

---

## Tier 4 — Polish & nice-to-haves

- ⬜ Rich-text editor for compose (Tiptap / Lexical)
- ⬜ Dark mode / themes
- ⬜ Keyboard shortcuts (? to show, j/k, c, r, etc.)
- ⬜ i18n (NL/EN toggle — NL is hardcoded in several places)
- ⬜ Scheduled send
- ⬜ Undo send (5 s window)
- ⬜ Rules / filters (auto-tag by sender, auto-archive newsletters, …)
- ⬜ IMAP IDLE push (replace polling)
- ⬜ PWA install prompt
- ⬜ Accessibility polish (aria, keyboard nav, screen-reader labels)
- ⬜ Unified inbox view (across all accounts)
- ⬜ Multi-select on message list (bulk tag / delete)

---

## Decisions made (reference)

| Topic | Decision | Source |
|---|---|---|
| Frontend framework | Stay single-file React CDN until complexity forces a build | 2026-04-19 |
| Backend | Node.js + Fastify (TypeScript) | 2026-04-19 |
| DB | Supabase (Postgres + Auth + RLS) | 2026-04-19 |
| Backend host | Fly.io Frankfurt | 2026-04-19 |
| Frontend host | GitHub Pages | 2026-04-19 |
| Retention | 90 days for deleted → EXPUNGE | 2026-04-19 |
| Sync scope | INBOX + Sent, last 90 days, cap 100/folder/sync | 2026-04-19 |
| Initial sync depth | 90 days | 2026-04-19 |
| Auth model | Eigen ConvoTrail-wachtwoord, los van IMAP creds | 2026-04-19 |
| Signup | Invite-only | 2026-04-19 |
| Contacts source | Own DB, with later option for CardDAV import | 2026-04-19 |
| Drafts | Sync across devices when user clicks "Save draft"; "X" = discard | 2026-04-19 |
| Search | Progressive: synced-period fast, older via IMAP SEARCH | 2026-04-19 |
| Rich-text compose | Plain-text MVP; component-shaped for later swap | 2026-04-19 |
| Attachments in MVP | UI present, actual storage deferred | 2026-04-19 |
| Gmail labels | Ignored in MVP (map to ConvoTrail tags if needed later) | 2026-04-19 |
| Gmail auth | OAuth2 (refresh token), not basic | 2026-04-19 |
| iCloud auth | App-specific password | 2026-04-19 |
| Sync mechanism | Polling, not IMAP IDLE in MVP | 2026-04-19 |

---

## Open questions still to answer

- What to do with IMAP folders beyond Inbox/Sent? (Drafts/Trash/Spam sync yes, arbitrary user folders ignored or mapped to tags?)
- Contacts who exist on only a deselected account: hide from left column, or show with zeroed counts? Currently: shown as long as any of their activity is on any selected account.
- Rate-limit strategy for per-user background syncs when scaling past ~20 users.
- Whether to run our own SMTP relay vs trusting user's SMTP provider (currently: use user's SMTP — nodemailer connects outbound per-send).
- Retention edge case: if IMAP-provider itself purges sooner than 90 d (Gmail Trash = 30 d), our cached row may outlive the server side. Decision: follow IMAP, not our deadline — sync-driven cleanup.
