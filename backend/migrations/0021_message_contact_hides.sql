-- Migration 0021: per-(message, contact) "hide from this thread"
-- state, used to implement the multi-recipient delete dialog
-- ("All addressees" vs "Only this one") added in v0.0.208.
--
-- Background: with the v0.0.206 multi-contact shape, a single outgoing
-- mail to e.g. To=Alice, Cc=Bob, Bcc=Carla appears as three entries in
-- the FE's messageList — one row per recipient's contact thread. The
-- regular soft-delete (messages.deleted_at) operates per-mail, so
-- "delete" used to nuke the mail from all three threads. Some users
-- want to hide it from just one. This table stores that asymmetry.
--
-- The "All" branch in the delete dialog still flips messages.deleted_at
-- the same way it always did — message_contact_hides is only touched
-- by "Only this", and never replaces the global soft-delete.

CREATE TABLE IF NOT EXISTS message_contact_hides (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_message_contact_hides_user
  ON message_contact_hides(user_id);
CREATE INDEX IF NOT EXISTS idx_message_contact_hides_contact
  ON message_contact_hides(contact_id);

ALTER TABLE message_contact_hides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mch_owner_select ON message_contact_hides;
DROP POLICY IF EXISTS mch_owner_insert ON message_contact_hides;
DROP POLICY IF EXISTS mch_owner_delete ON message_contact_hides;

CREATE POLICY mch_owner_select ON message_contact_hides
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY mch_owner_insert ON message_contact_hides
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY mch_owner_delete ON message_contact_hides
  FOR DELETE USING (auth.uid() = user_id);
