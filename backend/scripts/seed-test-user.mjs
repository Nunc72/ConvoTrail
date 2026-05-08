// One-shot script to create a Convooz test account with rich seed data.
// Usage:  node backend/scripts/seed-test-user.mjs
// Requires DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_KEY in env.
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const USERNAME = "demo";
const PASSWORD = "DemoConvooz!2026";
const EMAIL    = "demo-convooz-" + Date.now() + "@example.com";

const ACC_WORK    = { id: null, email: "rik@workdemo.example", name: "Rik (Work)" };
const ACC_PRIVATE = { id: null, email: "rik@privatedemo.example", name: "Rik (Private)" };

const CONTACTS = [
  { name: "Sophie van den Berg", org: "Berg Studio",        email: "sophie@berg.example",       color: "#6366f1" },
  { name: "Thomas de Groot",     org: null,                 email: "thomas.degroot@gmail.example", color: "#ec4899" },
  { name: "Ingrid Maassen",      org: "Bureau Maassen",     email: "ingrid@maassen.example",    color: "#10b981" },
  { name: "Pieter Janssen",      org: "Janssen & Zn",       email: "pjanssen@outlook.example",  color: "#f59e0b" },
  { name: "Lisa Hoekstra",       org: null,                 email: "lisa@hoekstra.example",     color: "#8b5cf6" },
  { name: "Mark Willemsen",      org: "Willemsen B.V.",     email: "m.willemsen@bedrijf.example", color: "#06b6d4" },
  { name: "Anna Smits",          org: null,                 email: "anna@smits.example",        color: "#f43f5e" },
  { name: "Architizer",          org: "Architizer Inc.",    email: "newsletter@architizer.example", color: "#64748b" },
];

function daysAgo(d) {
  return new Date(Date.now() - d * 86400_000).toISOString();
}

async function main() {
  // 1. Create Supabase user (or reuse).
  let userId;
  const existing = await sb.auth.admin.listUsers();
  const found = existing.data?.users?.find(u => u.user_metadata?.username === USERNAME);
  if (found) {
    userId = found.id;
    console.log("Reusing existing user", userId);
    // Reset its password so the printed creds always work.
    await sb.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      user_metadata: { display_name: "Convooz Demo", username: USERNAME, is_test_account: true },
    });
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email: EMAIL, password: PASSWORD, email_confirm: true,
      user_metadata: { display_name: "Convooz Demo", username: USERNAME, is_test_account: true },
    });
    if (error) { console.error("createUser:", error); process.exit(1); }
    userId = data.user.id;
    console.log("Created user", userId);
  }

  // 2. Wipe any prior data for this user (clean re-seed).
  const tables = ["message_tags", "messages", "drafts", "r2m_state", "tags", "contact_emails", "contacts", "mail_accounts"];
  for (const t of tables) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
  }

  // 3. user_usernames
  await pool.query(
    `INSERT INTO user_usernames (user_id, username) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
    [userId, USERNAME],
  );

  // 4. Mail accounts (no real IMAP creds — sync would fail; that's fine for UI).
  for (const acc of [ACC_WORK, ACC_PRIVATE]) {
    const r = await pool.query(
      `INSERT INTO mail_accounts (user_id, email, provider, display_name, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user)
         VALUES ($1, $2, 'generic', $3, 'imap.example', 993, $2, 'smtp.example', 465, $2)
       RETURNING id`,
      [userId, acc.email, acc.name],
    );
    acc.id = r.rows[0].id;
  }

  // 5. Contacts + contact_emails.
  const cIds = [];
  for (const c of CONTACTS) {
    const r = await pool.query(
      `INSERT INTO contacts (user_id, name, org, color, primary_email, r2m_days)
         VALUES ($1, $2, $3, $4, $5, 3) RETURNING id`,
      [userId, c.name, c.org, c.color, c.email],
    );
    cIds.push(r.rows[0].id);
    await pool.query(
      `INSERT INTO contact_emails (contact_id, user_id, email) VALUES ($1, $2, $3)`,
      [r.rows[0].id, userId, c.email],
    );
  }

  // 6. Tags.
  const tagNames = ["project", "factuur"];
  const tagIds = [];
  for (const n of tagNames) {
    const r = await pool.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, n],
    );
    tagIds.push(r.rows[0].id);
  }

  // 7. Messages — a varied mix.
  let uid = 100;
  const insertMsg = async (m) => {
    const r = await pool.query(
      `INSERT INTO messages
         (user_id, mail_account_id, folder, uid, uidvalidity, message_id, thread_id,
          from_email, from_name, to_emails, subject, snippet, body_text, date,
          flags, direction, deleted_at, has_attachments)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15,$16,false)
       RETURNING id`,
      [
        userId, m.acct, m.folder, uid++, m.message_id || null, m.thread_id || null,
        m.from_email, m.from_name || null,
        JSON.stringify(m.to || []),
        m.subject, m.snippet || m.body?.slice(0, 100) || null, m.body || null,
        m.date, JSON.stringify(m.flags || {}), m.dir, m.deleted_at || null,
      ],
    );
    return r.rows[0].id;
  };

  const sophie  = CONTACTS[0].email; const sophieN = CONTACTS[0].name;
  const thomas  = CONTACTS[1].email; const thomasN = CONTACTS[1].name;
  const ingrid  = CONTACTS[2].email; const ingridN = CONTACTS[2].name;
  const pieter  = CONTACTS[3].email;
  const lisa    = CONTACTS[4].email;
  const mark    = CONTACTS[5].email;
  const anna    = CONTACTS[6].email;
  const archi   = CONTACTS[7].email; const archiN  = CONTACTS[7].name;

  const msgs = [];

  // Sophie thread (work account)
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX", from_email: sophie, from_name: sophieN,
    to: [{role:"to", email: ACC_WORK.email}], subject: "Voorstel samenwerking Q3",
    body: "Hoi,\n\nIk wilde even checken of jullie interesse hebben in een samenwerking voor Q3. Kun je volgende week bellen?\n\nGroeten,\nSophie",
    date: daysAgo(0.2), dir: "in", flags: {seen:false},
    message_id: "<sophie-1@workdemo>", thread_id: null,
  }));
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX.Sent", from_email: ACC_WORK.email, from_name: "Rik",
    to: [{role:"to", email: sophie}], subject: "Re: Voorstel samenwerking Q3",
    body: "Hi Sophie,\n\nDank voor je bericht. Ik kan dinsdag of woensdag.\n\nGroeten,\nRik",
    date: daysAgo(0.5), dir: "out", flags: {seen:true},
    message_id: "<rik-replytosophie@workdemo>", thread_id: "<sophie-1@workdemo>",
  }));

  // Thomas thread (work account, with R2M on outgoing)
  const thomasOutId = await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX.Sent", from_email: ACC_WORK.email, from_name: "Rik",
    to: [{role:"to", email: thomas}], subject: "Bevindingen memory leak",
    body: "Thomas,\n\nHet lek zit in TokenRefreshHandler. Fix in PR #214. Reviewen?\n\nGr",
    date: daysAgo(2), dir: "out", flags: {seen:true},
    message_id: "<rik-thomas-leak@workdemo>", thread_id: null,
  });
  msgs.push(thomasOutId);
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX", from_email: thomas, from_name: thomasN,
    to: [{role:"to", email: ACC_WORK.email}], subject: "Factuur april 2026",
    body: "Goedemorgen,\n\nIn de bijlage de factuur voor april. Graag voor de 20e betalen.\n\nFactuur #2026-041\nBedrag: €1.850,00 excl. BTW",
    date: daysAgo(1), dir: "in", flags: {seen:false},
    message_id: "<thomas-factuur@workdemo>", thread_id: null,
  }));

  // R2m armed on the Thomas outgoing
  await pool.query(
    `INSERT INTO r2m_state (message_id, user_id, snooze_until, snooze_count)
       VALUES ($1, $2, now() + interval '5 days', 0)`,
    [thomasOutId, userId],
  );

  // Ingrid thread (private account)
  msgs.push(await insertMsg({
    acct: ACC_PRIVATE.id, folder: "INBOX.Sent", from_email: ACC_PRIVATE.email, from_name: "Rik",
    to: [{role:"to", email: ingrid}], subject: "Uitnodiging netwerkborrel 17 april",
    body: "Beste Ingrid,\n\nHierbij een uitnodiging voor onze netwerkborrel op 17 april vanaf 16:30.\n\nLocatie: De Balie\n\nGroeten",
    date: daysAgo(3), dir: "out", flags: {seen:true},
    message_id: "<rik-ingrid-borrel@privatedemo>", thread_id: null,
  }));
  msgs.push(await insertMsg({
    acct: ACC_PRIVATE.id, folder: "INBOX", from_email: ingrid, from_name: ingridN,
    to: [{role:"to", email: ACC_PRIVATE.email}], subject: "Re: Uitnodiging netwerkborrel",
    body: "Leuk! Ik kom graag. Tot de 17e!",
    date: daysAgo(2.5), dir: "in", flags: {seen:true},
    message_id: "<ingrid-reply@privatedemo>", thread_id: "<rik-ingrid-borrel@privatedemo>",
  }));

  // Pieter — incoming question + draft reply (work)
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX", from_email: pieter, from_name: "Pieter Janssen",
    to: [{role:"to", email: ACC_WORK.email}], subject: "Vraag over de offerte",
    body: "Goedemiddag,\n\nIk had nog een vraag over de offerte. Kunnen jullie de post 'Ontwikkeluren' nader toelichten?\n\nMet vriendelijke groet,\nPieter",
    date: daysAgo(1.5), dir: "in", flags: {seen:false},
  }));

  // Lisa — older read incoming (private)
  msgs.push(await insertMsg({
    acct: ACC_PRIVATE.id, folder: "INBOX", from_email: lisa, from_name: "Lisa Hoekstra",
    to: [{role:"to", email: ACC_PRIVATE.email}], subject: "Feestje zaterdag",
    body: "Hey! Zaterdag borrel bij mij thuis vanaf 20:00. Kom je ook?",
    date: daysAgo(7), dir: "in", flags: {seen:true},
  }));

  // Mark — agenda
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX", from_email: mark, from_name: "Mark Willemsen",
    to: [{role:"to", email: ACC_WORK.email}], subject: "Agenda vergadering 10 april",
    body: "Geachte,\n\nBijgaand de agenda voor de vergadering van 10 april. Aanvang 14:00 uur.",
    date: daysAgo(5), dir: "in", flags: {seen:true},
  }));

  // Anna — referentie (work, deleted)
  msgs.push(await insertMsg({
    acct: ACC_WORK.id, folder: "INBOX.Sent", from_email: ACC_WORK.email, from_name: "Rik",
    to: [{role:"to", email: anna}], subject: "Aanvraag referentie",
    body: "Hoi Anna,\n\nZou je als referentie willen optreden voor een aanvraag?\n\nGr",
    date: daysAgo(10), dir: "out", flags: {seen:true},
    deleted_at: daysAgo(8),
  }));

  // Architizer newsletter (private)
  msgs.push(await insertMsg({
    acct: ACC_PRIVATE.id, folder: "INBOX", from_email: archi, from_name: archiN,
    to: [{role:"to", email: ACC_PRIVATE.email}], subject: "Top 10 bureaus dit voorjaar",
    body: "De Architizer redactie selecteerde de tien meest opvallende bureaus van dit voorjaar…",
    date: daysAgo(4), dir: "in", flags: {seen:true},
  }));

  // 8. Drafts.
  await pool.query(
    `INSERT INTO drafts (user_id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, tags)
       VALUES ($1, $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, $4, $5, '[]'::jsonb)`,
    [userId, ACC_WORK.id, JSON.stringify([{role:"to", email: thomas}]),
     "Re: Factuur april — specificatie",
     "Thomas,\n\nIk heb de factuur ontvangen. Kun je een specificatie sturen?\n\nGr"],
  );
  await pool.query(
    `INSERT INTO drafts (user_id, mail_account_id, to_emails, cc_emails, bcc_emails, subject, body, tags)
       VALUES ($1, $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, $4, $5, '[]'::jsonb)`,
    [userId, ACC_PRIVATE.id, JSON.stringify([{role:"to", email: lisa}]),
     "Re: Feestje", "Hi Lisa,\n\nIk kom! Mag ik iets meenemen?\n\nGr"],
  );

  // 9. Tag a couple of messages.
  await pool.query(
    `INSERT INTO message_tags (message_id, user_id, tag_id) VALUES ($1, $2, $3)`,
    [thomasOutId, userId, tagIds[0]],
  );

  console.log("\n──────────────────────────────────────────");
  console.log("  Convooz demo account ready");
  console.log("──────────────────────────────────────────");
  console.log("  URL:      https://nunc72.github.io/ConvoTrail/");
  console.log("  Username:", USERNAME);
  console.log("  Password:", PASSWORD);
  console.log("──────────────────────────────────────────\n");
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
