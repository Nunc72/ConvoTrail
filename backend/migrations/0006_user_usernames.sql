-- Free-format login usernames, decoupled from email.
-- Supabase Auth keeps email as its primary identifier (needed for password
-- reset and OAuth interop), so we keep a side table for username → user_id
-- with a UNIQUE constraint Supabase doesn't give us on user_metadata.

CREATE TABLE IF NOT EXISTS user_usernames (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness so "Rik" and "rik" can't both register.
CREATE UNIQUE INDEX IF NOT EXISTS user_usernames_username_lower_idx
  ON user_usernames (LOWER(username));

ALTER TABLE user_usernames ENABLE ROW LEVEL SECURITY;

-- Each user can read/update their own row. Public lookup happens via a
-- backend route using the service key, never directly from the client.
DROP POLICY IF EXISTS user_usernames_self ON user_usernames;
CREATE POLICY user_usernames_self ON user_usernames
  FOR ALL USING (user_id = auth.uid());

-- Backfill existing accounts: their email becomes the initial username.
-- Users can change it from Settings → Profile.
INSERT INTO user_usernames (user_id, username)
  SELECT id, email FROM auth.users
  WHERE email IS NOT NULL AND email <> ''
ON CONFLICT (user_id) DO NOTHING;
