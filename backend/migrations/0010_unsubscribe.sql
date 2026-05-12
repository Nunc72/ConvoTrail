-- Migration 0010: List-Unsubscribe support.
--
-- Newsletter mail carries a List-Unsubscribe header (RFC 2369) with a URL
-- (or mailto:) the recipient can hit to opt out. Modern senders also add
-- List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058), which
-- means the server accepts a one-click POST and the mail client can
-- unsubscribe without opening a browser.
--
-- We persist:
--   unsubscribe_url       — the http(s) URL or mailto: from the header
--                           (we prefer http over mailto when both are
--                           present, since the one-click flow is HTTP)
--   unsubscribe_one_click — whether the One-Click POST is supported

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS unsubscribe_url        TEXT,
  ADD COLUMN IF NOT EXISTS unsubscribe_one_click  BOOLEAN NOT NULL DEFAULT FALSE;
