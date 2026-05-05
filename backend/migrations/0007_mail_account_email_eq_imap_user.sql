-- mail_accounts.email is the "from"-address used when sending. The invite
-- flow accidentally seeded it from inv.email (which post-v0.0.74 is the
-- ConvoTrail recovery email), so users see their recovery address bleed
-- into the mail-account UI. The IMAP login (imap_user) is the real
-- mailbox address, so realign email to that.

UPDATE mail_accounts
SET email = imap_user
WHERE imap_user IS NOT NULL
  AND imap_user <> ''
  AND email IS DISTINCT FROM imap_user;
