-- Compose-time tags are carried on the draft so saving + reopening a draft
-- restores them, and so replies inherit the original's tags all the way to
-- the sent message. Stored as a JSONB array of tag names (matches the
-- frontend's existing msgTags shape).
ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
