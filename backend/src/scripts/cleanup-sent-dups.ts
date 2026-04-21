// One-off maintenance: remove duplicate outgoing messages in folder="Sent"
// that were created by pre-v0.0.20 sends. For those sends we APPENDed to
// hardcoded "Sent" while the subsequent sync enumerated the true path (e.g.
// "Sent Messages" on iCloud) and inserted a second row with the same
// message_id. Here we delete the "Sent"-bucket row whenever a sibling with
// the same (mail_account_id, message_id) exists in a different folder.
//
// Run via:  flyctl ssh console -C "node dist/scripts/cleanup-sent-dups.js"
import { requirePool } from "../db.js";

async function main(): Promise<void> {
  const pool = requirePool();
  const r = await pool.query<{
    id: string; folder: string; message_id: string | null; subject: string | null;
  }>(
    `DELETE FROM messages AS m
       WHERE m.folder = 'Sent'
         AND m.direction = 'out'
         AND m.message_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM messages m2
            WHERE m2.mail_account_id = m.mail_account_id
              AND m2.message_id      = m.message_id
              AND m2.folder         <> 'Sent'
         )
     RETURNING m.id, m.folder, m.message_id, m.subject`,
  );
  console.log(`deleted ${r.rowCount ?? 0} duplicate Sent row(s):`);
  for (const row of r.rows) {
    const subj = (row.subject ?? "(no subject)").slice(0, 70);
    console.log(`  ${row.id}  "${subj}"  (${row.message_id})`);
  }
  await pool.end();
}

main().catch(e => {
  console.error("cleanup failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
