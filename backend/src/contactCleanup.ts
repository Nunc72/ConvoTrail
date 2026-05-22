// Orphan-contact sweeper.
//
// A contact is an "orphan" when none of its emails can be matched against
// any messages row for the same user — neither as the message's
// from_email nor as any entry in the message's to_emails jsonb array.
// Mails living in the Trash folder (deleted_at IS NOT NULL) still count
// as "having a mail" because Convooz shows them in the Deleted tab; only
// when the underlying row is *gone* (permanent delete) does the contact
// truly lose its last association.
//
// We sweep at two trigger points (see callers):
//   • DELETE /mail-accounts/:id  — after the cascade wipes a whole
//     account's messages, contacts that had no activity in any other
//     account become orphans.
//   • sync.ts end of run         — the permanent-delete detection pass
//     hard-removes DB rows whose UIDs disappeared from IMAP (e.g. Gmail
//     auto-purged Trash at 30 days); contacts whose last message just
//     got swept get cleaned up here.
//
// We deliberately do NOT call this on Convooz soft-deletes — the mail
// still exists, so the contact should remain visible.
import { requirePool } from "./db.js";

export async function cleanupOrphanContacts(userId: string): Promise<number> {
  const pool = requirePool();
  const r = await pool.query(
    `DELETE FROM contacts c
      WHERE c.user_id = $1
        AND NOT EXISTS (
          SELECT 1
            FROM contact_emails ce
            JOIN messages m
              ON m.user_id = c.user_id
             AND (
                   LOWER(m.from_email) = LOWER(ce.email)
                   OR EXISTS (
                     SELECT 1 FROM jsonb_array_elements(
                                       COALESCE(m.to_emails, '[]'::jsonb)
                                     ) te
                      WHERE LOWER(te->>'email') = LOWER(ce.email)
                   )
                 )
           WHERE ce.contact_id = c.id
        )`,
    [userId],
  );
  return r.rowCount ?? 0;
}
