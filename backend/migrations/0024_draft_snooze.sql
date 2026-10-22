-- v0.0.320 — Snooze / Forget for drafts. An actionable draft (saved, not
-- snoozed, not forgotten) gets a grey dot, a grey badge and the grey
-- "Draft" banner, the way unread mail and revert2me do. Mails keep this
-- state in r2m_state, but its message_id references messages(id), so a
-- draft carries it itself:
--   snooze_until  hidden from the actionables until then (Fibonacci days)
--   dismissed_at  forgotten: no more alerts until the draft is saved again
--   snooze_count  position in the 3 / 5 / 8 / 13 … day schedule
-- Additive and nullable, so the running backend is unaffected.
ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snooze_count INT NOT NULL DEFAULT 0;
