-- Migration 0009: track sync progress per mail account.
--
-- sync_known_uids is the total number of UIDs the IMAP server reported
-- inside our SINCE_DAYS window, summed over INBOX + SENT, at the time of
-- the most recent sync. The DB row count for the account divided by this
-- gives the "X of Y mails synced" progress shown in the user menu while
-- the per-folder catch-up is filling in older mails.
--
-- Nullable: an account that has never synced has nothing meaningful here.

ALTER TABLE mail_accounts
  ADD COLUMN IF NOT EXISTS sync_known_uids INT;
