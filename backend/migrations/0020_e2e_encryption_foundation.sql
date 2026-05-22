-- Migration 0020: foundation for client-side end-to-end encryption.
--
-- The plan (Pad A): all sensitive per-user fields (mail bodies, subjects,
-- addresses, contact cards) get stored encrypted with a per-user master
-- key the server never persists. The key lives only in the user's
-- browser memory, derived at login from a passphrase via Argon2id.
-- A wrapped (= passphrase-encrypted) copy of the master key sits in
-- the new user_crypto table so the user can unlock on a new device by
-- entering their passphrase again. Without the passphrase the wrapped
-- key is a useless blob.
--
-- Two flavours of ciphertext are needed on each protected field:
--   *_enc   = random-IV AES-256-GCM ciphertext for display data
--             (admin sees random bytes, no patterns)
--   *_blind = deterministic HMAC-SHA256 over the plaintext with the
--             user's blind-index key, so the BACKEND can still match
--             email-to-contact links and run targeted lookups without
--             ever seeing the plaintext. Frequency patterns leak (a
--             given encrypted address appears N times) but not the
--             actual address.
--
-- All new columns are NULLABLE so this migration is purely additive —
-- existing plaintext columns + the FTS index stay in place. The cut-
-- over and the eventual plaintext-column drop happen in later
-- migrations after the encrypted write-path lands and the per-user
-- backfill flow has migrated existing rows.

-- 1. Per-user crypto material (salt + wrapped master key).
CREATE TABLE IF NOT EXISTS user_crypto (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  passphrase_salt      BYTEA NOT NULL,                       -- 32 random bytes, NOT secret
  wrapped_master_key   BYTEA NOT NULL,                       -- AES-256-GCM(masterKey, kdf(passphrase, salt))
  kdf_algorithm        TEXT  NOT NULL DEFAULT 'argon2id',
  kdf_params           JSONB NOT NULL DEFAULT '{"opslimit": 3, "memlimit": 67108864}'::jsonb,
  cipher_algorithm     TEXT  NOT NULL DEFAULT 'aes-256-gcm',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_crypto ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_crypto_owner_select ON user_crypto;
DROP POLICY IF EXISTS user_crypto_owner_insert ON user_crypto;
DROP POLICY IF EXISTS user_crypto_owner_update ON user_crypto;
DROP POLICY IF EXISTS user_crypto_owner_delete ON user_crypto;

CREATE POLICY user_crypto_owner_select ON user_crypto
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY user_crypto_owner_insert ON user_crypto
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_crypto_owner_update ON user_crypto
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_crypto_owner_delete ON user_crypto
  FOR DELETE USING (auth.uid() = user_id);

-- 2. messages — body, subject, addresses.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS body_text_enc      BYTEA,
  ADD COLUMN IF NOT EXISTS body_html_enc      BYTEA,
  ADD COLUMN IF NOT EXISTS snippet_enc        BYTEA,
  ADD COLUMN IF NOT EXISTS subject_enc        BYTEA,
  ADD COLUMN IF NOT EXISTS from_email_enc     BYTEA,
  ADD COLUMN IF NOT EXISTS from_email_blind   BYTEA,
  ADD COLUMN IF NOT EXISTS from_name_enc      BYTEA,
  ADD COLUMN IF NOT EXISTS to_emails_enc      BYTEA,
  ADD COLUMN IF NOT EXISTS to_emails_blind    BYTEA[];

-- 3. contacts — display fields + matchable primary email.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS name_enc            BYTEA,
  ADD COLUMN IF NOT EXISTS org_enc             BYTEA,
  ADD COLUMN IF NOT EXISTS primary_email_enc   BYTEA,
  ADD COLUMN IF NOT EXISTS primary_email_blind BYTEA;

-- 4. contact_emails — every linked address.
ALTER TABLE contact_emails
  ADD COLUMN IF NOT EXISTS email_enc   BYTEA,
  ADD COLUMN IF NOT EXISTS email_blind BYTEA;

-- 5. Indexes for blind-index matching. These are the lookups the
--    backend will do once the cut-over completes: linking a fetched
--    mail's from_email to a contact_emails row via blind-index
--    equality, and bulk-searching to_emails by recipient.
CREATE INDEX IF NOT EXISTS idx_messages_from_email_blind
  ON messages(from_email_blind)
  WHERE from_email_blind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_to_emails_blind_gin
  ON messages USING GIN (to_emails_blind)
  WHERE to_emails_blind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contact_emails_blind
  ON contact_emails(email_blind)
  WHERE email_blind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_primary_email_blind
  ON contacts(primary_email_blind)
  WHERE primary_email_blind IS NOT NULL;
