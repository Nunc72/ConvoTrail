-- Phase 1.5a/b/c — encryption of contact data while keeping plaintext
-- columns intact (dual-write). Plaintext drop is a separate step that
-- only happens once Rik has tested the encrypted path end-to-end.
--
-- 1.5a   contact_emails.email_blind: deterministic HMAC for the
--        server to JOIN messages-by-sender without ever seeing the
--        plaintext email. Indexed on (user_id, email_blind) so the
--        sync match step is cheap.
-- 1.5b   contacts.name_enc / contacts.org_enc: AES-GCM ciphertext of
--        the human-readable contact fields. FE decrypts when
--        unlocked, plaintext stays as fallback for locked sessions.
-- 1.5c   contact_emails.email_enc: AES-GCM ciphertext of the email
--        address itself. Same dual-write pattern.

ALTER TABLE contact_emails
  ADD COLUMN IF NOT EXISTS email_blind BYTEA,
  ADD COLUMN IF NOT EXISTS email_enc   BYTEA;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS name_enc BYTEA,
  ADD COLUMN IF NOT EXISTS org_enc  BYTEA;

CREATE INDEX IF NOT EXISTS contact_emails_email_blind_idx
  ON contact_emails(user_id, email_blind)
  WHERE email_blind IS NOT NULL;
