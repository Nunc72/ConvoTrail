// Revert-to-me timer helpers. r2m is enabled per outgoing message; the DB
// row tracks dismissed_at (permanent hide), snooze_until (hide-until), and
// snooze_count (for the Fibonacci back-off schedule).
import { requirePool } from "./db.js";

// Fibonacci snooze schedule — matches the frontend's fibSnoozeDays():
// count 0 → 3, 1 → 5, 2 → 8, 3 → 13, 4 → 21, 5 → 34 days, etc.
export function fibSnoozeDays(count: number): number {
  if (count <= 0) return 3;
  if (count === 1) return 5;
  let a = 3, b = 5;
  for (let i = 2; i <= count; i++) { const c = a + b; a = b; b = c; }
  return b;
}

// Arm r2m on a message. armDays=0 activates immediately (useful for quick
// testing when the user lowers a contact's r2m_days to 0).
export async function armR2m(
  messageId: string,
  userId: string,
  armDays: number,
  sentAt: Date = new Date(),
): Promise<void> {
  const pool = requirePool();
  const snoozeUntil = armDays > 0 ? new Date(sentAt.getTime() + armDays * 86400_000) : null;
  await pool.query(
    `INSERT INTO r2m_state (message_id, user_id, snooze_until, snooze_count)
       VALUES ($1, $2, $3, 0)
     ON CONFLICT (message_id) DO UPDATE
       SET dismissed_at = NULL, snooze_until = EXCLUDED.snooze_until, snooze_count = 0`,
    [messageId, userId, snoozeUntil],
  );
}
