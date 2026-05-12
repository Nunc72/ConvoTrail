-- Migration 0011: track whether the user has explicitly toggled the
-- contact's News flag (in either direction).
--
-- The sync now auto-flips contacts.is_news = true when any incoming mail
-- has a List-Unsubscribe header. We must NOT keep re-flipping it after
-- the user has manually toggled News off (or on) — their choice wins.
--
-- Rule:
--   is_news_user_set = FALSE  →  sync may auto-set is_news = true
--   is_news_user_set = TRUE   →  sync leaves is_news alone
--
-- The frontend sets is_news_user_set = true whenever the user flips the
-- News flag (either direction), via the contact-flag toggle endpoint.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_news_user_set BOOLEAN NOT NULL DEFAULT FALSE;
