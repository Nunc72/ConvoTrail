-- Migration 0022: per-contact soft-delete timestamp.
--
-- Implements Rik's item 3 from the v0.0.207 list: deleting a contact
-- now soft-deletes the contact itself + all mail attributed to that
-- contact. The contact stays visible in the LeftColumn Archive view
-- with a "Deleted" chip; the mails land in the contact's Deleted tab
-- via the existing messages.deleted_at machinery.
--
-- When the IMAP Trash later auto-empties (Gmail's 30-day rule, or
-- the user manually purging), the per-folder permanent-delete
-- detection in sync.ts hard-deletes the now-gone mail rows from the
-- DB. cleanupOrphanContacts then removes the contact for good
-- (defined as "no contact_emails of theirs match any message"), which
-- in particular applies to contacts whose every mail was just purged.
--
-- No backfill needed — column defaults NULL, existing rows stay live.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at
  ON contacts(deleted_at)
  WHERE deleted_at IS NOT NULL;
