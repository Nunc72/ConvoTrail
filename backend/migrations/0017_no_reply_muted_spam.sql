-- Split the old "muted" flag into two distinct states + add a Spam
-- marker on messages.
--
-- Before this migration the "Vendors" tab in the UI was backed by a
-- `contacts.is_muted` column whose semantic was "I don't actively reply
-- to these people but their mail still belongs in the timeline". The
-- product is now growing a separate "Muted" tab for senders that should
-- effectively be suppressed (typically because the user reported their
-- mail as spam). That requires:
--   • renaming the existing is_muted to is_no_reply (so the column
--     name actually reflects what it means);
--   • adding a fresh is_muted column for the new aggressive-mute
--     semantic;
--   • adding mute_reason so the UI can render "Spam" on contacts
--     that were auto-muted via the Spam action vs. plain user-muted
--     ones;
--   • adding messages.spam so a deleted-via-Spam mail can carry the
--     "Spam" label in the deleted list (separate from a plain delete).
--
-- contact_emails carries the same flags so a single email of a multi-
-- email contact can be muted/no-reply independently. Same rename
-- applies; no mute_reason there since the email-level marker doesn't
-- need to distinguish spam vs. manual.

BEGIN;

-- contacts -----------------------------------------------------------
ALTER TABLE contacts RENAME COLUMN is_muted TO is_no_reply;
ALTER TABLE contacts
  ADD COLUMN is_muted    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN mute_reason TEXT;
COMMENT ON COLUMN contacts.is_no_reply IS
  'True: user does not reply to this contact (the "noReply" tab, previously labeled Vendors).';
COMMENT ON COLUMN contacts.is_muted IS
  'True: contact is muted — appears in the Muted tab. Typically set by the Spam action.';
COMMENT ON COLUMN contacts.mute_reason IS
  'When is_muted is true, optional explanation (e.g. "spam") used to badge the row in the contact list.';

-- contact_emails -----------------------------------------------------
ALTER TABLE contact_emails RENAME COLUMN is_muted TO is_no_reply;
ALTER TABLE contact_emails
  ADD COLUMN is_muted BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN contact_emails.is_no_reply IS
  'Per-email override of the contact-level noReply flag.';
COMMENT ON COLUMN contact_emails.is_muted IS
  'Per-email override of the contact-level Muted flag.';

-- messages -----------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN spam BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN messages.spam IS
  'True: user reported this mail as spam. Always paired with a deleted_at value; surfaces the "Spam" label in the deleted-mail list.';

COMMIT;
