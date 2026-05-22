-- Migration 0019: one-shot flag on mail_accounts to mark that the
-- All-Mail consolidation pass has already run for this account.
--
-- Previously sync.ts ran the "delete non-AllMail/non-Trash rows" block
-- on every sync as long as the IMAP server advertised \All. That had
-- an unintended side effect: a freshly-sent mail from Convooz lands in
-- the DB with folder = [Gmail]/Sent Mail; the very next sync deleted
-- that row before the All Mail re-fetch could pick it up, so Sent mail
-- repeatedly vanished from the UI.
--
-- With this flag, the consolidation runs exactly once per account on
-- its first post-deploy sync, then is skipped forever after. The
-- combined smtp.ts All-Mail-uid-lookup means new sent mail lands
-- directly under the All Mail folder anyway, so even a stale flag
-- would do no harm.

ALTER TABLE mail_accounts
  ADD COLUMN IF NOT EXISTS migrated_to_all_mail BOOLEAN NOT NULL DEFAULT FALSE;
