// v0.0.258 migratie — flip self-send INBOX-rijen die ten onrechte
// direction='out' kregen door de oude buildMessageRow logica.
//
// Doel: voor elke mail_account waar folder='INBOX' AND direction='out'
// AND from_email == account.email, zet direction='in'. Andere folders
// (INBOX.Sent, INBOX.Trash, Gmail All-Mail) blijven onaangetast.
//
// Self-contact wordt NIET hier aangemaakt — dat doet de orphan-recovery
// in sync.ts automatisch op de eerstvolgende unlocked sync.
//
// Run met expliciete DB url. Refuses non-matching prefixes als veiligheid.
//   STAGING_DATABASE_URL=... node migrate-self-send-direction.mjs --target staging
//   PROD_DATABASE_URL=...    node migrate-self-send-direction.mjs --target prod
import pg from "pg";

const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
if (targetIdx === -1) {
  console.error("usage: node migrate-self-send-direction.mjs --target staging|prod");
  process.exit(2);
}
const target = args[targetIdx + 1];
let connectionString;
if (target === "staging") {
  if (!process.env.STAGING_DATABASE_URL) { console.error("STAGING_DATABASE_URL missing"); process.exit(2); }
  if (!/dvzzuarhaligsbdobptg/.test(process.env.STAGING_DATABASE_URL)) {
    console.error("STAGING_DATABASE_URL doesn't match staging project id"); process.exit(2);
  }
  connectionString = process.env.STAGING_DATABASE_URL;
} else if (target === "prod") {
  if (!process.env.PROD_DATABASE_URL) { console.error("PROD_DATABASE_URL missing"); process.exit(2); }
  if (!/oyrlzqbjcsliesvunbwj/.test(process.env.PROD_DATABASE_URL)) {
    console.error("PROD_DATABASE_URL doesn't match prod project id"); process.exit(2);
  }
  connectionString = process.env.PROD_DATABASE_URL;
} else {
  console.error("--target must be staging or prod"); process.exit(2);
}

const s = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await s.connect();

// Preview first — show what would be changed
const preview = await s.query(`
  SELECT m.id::text, m.date::text, a.email AS account_email,
         m.from_email, m.folder, m.direction,
         LEFT(COALESCE(m.subject, ''), 60) AS subj
    FROM messages m
    JOIN mail_accounts a ON a.id = m.mail_account_id
   WHERE m.folder = 'INBOX'
     AND m.direction = 'out'
     AND LOWER(m.from_email) = LOWER(a.email)
   ORDER BY m.date DESC
`);

console.log(`[${target}] Rows to be flipped from out → in: ${preview.rows.length}\n`);
for (const row of preview.rows.slice(0, 20)) {
  console.log(`  acc=${row.account_email}  ${row.date.slice(0,19)}  uid-folder=${row.folder}  from=${row.from_email}`);
  console.log(`    subj: ${row.subj}`);
}
if (preview.rows.length > 20) console.log(`  ... and ${preview.rows.length - 20} more`);

if (preview.rows.length === 0) {
  console.log("Nothing to do. Exiting.");
  await s.end();
  process.exit(0);
}

// Confirm via env flag — script will only commit when CONFIRM=yes
if (process.env.CONFIRM !== "yes") {
  console.log("\nDry-run complete. To apply: re-run with CONFIRM=yes");
  await s.end();
  process.exit(0);
}

// Apply
const upd = await s.query(`
  UPDATE messages m
     SET direction = 'in'
    FROM mail_accounts a
   WHERE m.mail_account_id = a.id
     AND m.folder = 'INBOX'
     AND m.direction = 'out'
     AND LOWER(m.from_email) = LOWER(a.email)
`);
console.log(`\n[${target}] Updated ${upd.rowCount} rows.`);

// Quick sanity check after
const after = await s.query(`
  SELECT COUNT(*)::int AS cnt
    FROM messages m
    JOIN mail_accounts a ON a.id = m.mail_account_id
   WHERE m.folder = 'INBOX'
     AND m.direction = 'out'
     AND LOWER(m.from_email) = LOWER(a.email)
`);
console.log(`Remaining misclassified rows: ${after.rows[0].cnt}`);

await s.end();
