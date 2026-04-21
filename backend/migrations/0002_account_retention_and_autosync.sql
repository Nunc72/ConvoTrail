-- Per-account retention windows (null = keep forever) and an auto-sync toggle.
-- Retention values are not enforced yet — the cleanup cron lands in Tier 2.5.
-- Auto-sync is read by the frontend polling loop (Tier 1.10); off means the
-- account only syncs when the user clicks Sync.
ALTER TABLE mail_accounts
  ADD COLUMN IF NOT EXISTS retention_deleted_days INT,
  ADD COLUMN IF NOT EXISTS retention_spam_days    INT,
  ADD COLUMN IF NOT EXISTS auto_sync              BOOLEAN NOT NULL DEFAULT false;
