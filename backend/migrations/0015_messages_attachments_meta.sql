-- Cache the public attachment list per message so /body can skip the
-- IMAP round-trip on every revisit. Today every click on a mail with
-- attachments triggers a fresh IMAP connection (TCP + TLS + LOGIN +
-- SELECT + UID FETCH + LOGOUT, ~600-1500 ms each) just to rebuild the
-- attachments-meta list. Once this column is populated, /body can
-- return the cached body_text/body_html + attachments_meta directly
-- from Postgres in <50 ms.
--
-- The column is JSONB of shape:
--   [{ index, filename, contentType, size, isInline, cid }, ...]
-- Same shape as the public list /body returns, so /bootstrap can hand
-- it to the client unchanged.
--
-- NULL means "not yet enriched" — /body still goes to IMAP. After the
-- first successful enrichment it stays in place until the row itself
-- is updated (e.g. by a re-sync) which is allowed to clear it back
-- to NULL.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachments_meta JSONB;

COMMENT ON COLUMN messages.attachments_meta IS
  'Cached public attachments list (from /body parse). NULL = not yet enriched.';
