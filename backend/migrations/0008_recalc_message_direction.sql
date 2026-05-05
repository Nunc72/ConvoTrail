-- Recompute messages.direction based on the current mail_accounts.email.
-- During the invite-flow regression (pre-migration 0007), mail_accounts.email
-- was seeded with the user's recovery address instead of the IMAP login,
-- which made sync.ts classify every outgoing-via-this-account as "in"
-- (because from_email never matched the wrong acc.email). The IMAP rows
-- themselves were stored fine; only the derived direction is wrong.
--
-- Idempotent: rows where direction already matches stay as-is.

UPDATE messages m
SET direction = CASE
  WHEN lower(m.from_email) = lower(a.email) THEN 'out'
  ELSE 'in'
END
FROM mail_accounts a
WHERE a.id = m.mail_account_id
  AND m.direction <> CASE WHEN lower(m.from_email) = lower(a.email) THEN 'out' ELSE 'in' END;
