-- Per-draft attachments. The actual bytes live in Supabase Storage
-- (bucket: convotrail-attachments, path: userId/draftId/uuid-filename).
-- This table only tracks the pointer + display metadata so the UI can
-- render chips without a round-trip.
CREATE TABLE IF NOT EXISTS draft_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size         BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_draft_attachments_draft ON draft_attachments(draft_id);

ALTER TABLE draft_attachments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY draft_attachments_select ON draft_attachments FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY draft_attachments_insert ON draft_attachments FOR INSERT WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY draft_attachments_update ON draft_attachments FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY draft_attachments_delete ON draft_attachments FOR DELETE USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
