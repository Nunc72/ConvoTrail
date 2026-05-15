-- Migration 0014: audit log.
--
-- GDPR "accountability" requirement: keep a record of who did what to
-- what entity. Used for post-incident forensics and for users who want
-- to see their own history. We log security-relevant actions only —
-- creates, updates and deletes on mail accounts, account deletes,
-- unsubscribe clicks, credential changes. Reads are NOT logged
-- (every /bootstrap would balloon the table).
--
-- Retention: 180 days, enforced by a probabilistic cleanup in the
-- /bootstrap handler (1% chance per call) — no cron infrastructure
-- needed. Old rows are deleted, not pseudonymised, because by that
-- point they have no further forensic value.
--
-- On user delete: user_id SET NULL so the audit trail of the deletion
-- itself survives (verantwoording), but the row no longer points at
-- personal data — pseudonymisation in line with GDPR.

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_log_action       ON audit_log(action);
CREATE INDEX idx_audit_log_created      ON audit_log(created_at);

-- RLS: a user can read their own audit log; the backend service role
-- writes (no end-user INSERT path).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log
  FOR SELECT USING (user_id = auth.uid());
