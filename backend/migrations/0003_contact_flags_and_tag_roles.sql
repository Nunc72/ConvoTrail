-- News/Mute live on the contact card (not per e-mail address) per design.
-- Tag-level per-email role config (To/CC/BCC/...) persists as a JSONB map on
-- the tag row: { "someone@example.com": "To", ... }.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_news  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS email_roles JSONB NOT NULL DEFAULT '{}'::jsonb;
