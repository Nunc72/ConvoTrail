-- Migration 0018: track whether the user has explicitly toggled the
-- contact's Noreply flag. Mirror of 0011 for News.
--
-- The sync now auto-flips contacts.is_no_reply = true at CONTACT
-- CREATION time when the email's local part (before the @) matches
-- "noreply" or "no-reply". Existing contacts are not touched — Rik
-- prefers to set / unset Noreply manually on those.
--
-- Rule (used by PATCH /contacts/:id):
--   is_no_reply_user_set = FALSE  →  auto-tag at creation was the
--                                    last word
--   is_no_reply_user_set = TRUE   →  user has explicitly toggled
--                                    Noreply; future automation must
--                                    leave it alone
--
-- The PATCH /contacts/:id endpoint flips is_no_reply_user_set = true
-- whenever the user toggles Noreply, in either direction.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_no_reply_user_set BOOLEAN NOT NULL DEFAULT FALSE;
