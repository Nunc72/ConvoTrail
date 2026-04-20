-- ConvoTrail initial schema
-- Relies on Supabase auth.users being the source of truth for user identity.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── mail_accounts ──────────────────────────────────────────────────────────
CREATE TABLE mail_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('generic', 'icloud', 'gmail')),
  display_name    TEXT,
  imap_host       TEXT,
  imap_port       INT,
  imap_user       TEXT,
  imap_cred_enc   BYTEA,               -- AES-256 encrypted IMAP password
  smtp_host       TEXT,
  smtp_port       INT,
  smtp_user       TEXT,
  smtp_cred_enc   BYTEA,
  oauth_refresh_enc BYTEA,             -- for Gmail; null otherwise
  last_sync_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);
CREATE INDEX idx_mail_accounts_user ON mail_accounts(user_id);

-- ─── messages ───────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mail_account_id UUID NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder          TEXT NOT NULL,       -- 'INBOX' | 'Sent' | 'Trash' etc.
  uid             BIGINT NOT NULL,     -- IMAP UID
  uidvalidity     BIGINT NOT NULL,     -- IMAP UIDVALIDITY at time of sync
  message_id      TEXT,                -- RFC822 Message-ID header
  thread_id       TEXT,                -- conversation threading key
  from_email      TEXT,
  from_name       TEXT,
  to_emails       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{email,name,role:'to'|'cc'|'bcc'}]
  subject         TEXT,
  snippet         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  date            TIMESTAMPTZ,
  flags           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {seen,answered,flagged,draft}
  direction       TEXT CHECK (direction IN ('in','out')),
  deleted_at      TIMESTAMPTZ,         -- soft-delete; hard-delete via retention cron
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mail_account_id, folder, uid, uidvalidity)
);
CREATE INDEX idx_messages_user_date ON messages(user_id, date DESC);
CREATE INDEX idx_messages_thread ON messages(user_id, thread_id);
CREATE INDEX idx_messages_account ON messages(mail_account_id);
CREATE INDEX idx_messages_deleted ON messages(user_id, deleted_at) WHERE deleted_at IS NOT NULL;
-- Full-text search: subject + snippet + body_text
CREATE INDEX idx_messages_fts ON messages
  USING GIN (to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(body_text,'')));

-- ─── contacts ───────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT,
  org             TEXT,
  portrait_url    TEXT,
  color           TEXT,
  r2m_days        INT DEFAULT 3,
  primary_email   TEXT,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contacts_user ON contacts(user_id);
CREATE INDEX idx_contacts_name_trgm ON contacts USING GIN (name gin_trgm_ops);

CREATE TABLE contact_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  is_news         BOOLEAN NOT NULL DEFAULT false,
  is_muted        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (contact_id, email)
);
CREATE INDEX idx_contact_emails_email ON contact_emails(user_id, email);

-- ─── tags ───────────────────────────────────────────────────────────────────
CREATE TABLE tags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE message_tags (
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, tag_id)
);
CREATE INDEX idx_message_tags_tag ON message_tags(tag_id);

CREATE TABLE contact_tags (
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX idx_contact_tags_tag ON contact_tags(tag_id);

-- ─── drafts ─────────────────────────────────────────────────────────────────
CREATE TABLE drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mail_account_id UUID REFERENCES mail_accounts(id) ON DELETE SET NULL,
  to_emails       JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_emails       JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_emails      JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject         TEXT,
  body            TEXT,
  signature_id    UUID,
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_drafts_user ON drafts(user_id, modified_at DESC);

-- ─── signatures ─────────────────────────────────────────────────────────────
CREATE TABLE signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE drafts
  ADD CONSTRAINT drafts_signature_fk FOREIGN KEY (signature_id) REFERENCES signatures(id) ON DELETE SET NULL;

CREATE TABLE account_signatures (
  mail_account_id UUID NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  signature_id    UUID NOT NULL REFERENCES signatures(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_auto         BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (mail_account_id, signature_id)
);

-- ─── r2m_state (revert-to-me) ───────────────────────────────────────────────
CREATE TABLE r2m_state (
  message_id      UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dismissed_at    TIMESTAMPTZ,
  snooze_until    TIMESTAMPTZ,
  snooze_count    INT NOT NULL DEFAULT 0
);

-- ─── invites (invite-only signup) ───────────────────────────────────────────
CREATE TABLE invites (
  token           TEXT PRIMARY KEY,
  email           TEXT,                -- optional pre-bind to specific email
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  used_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at         TIMESTAMPTZ
);

-- ─── Row-Level Security ─────────────────────────────────────────────────────
ALTER TABLE mail_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_emails     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags               ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_tags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE r2m_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites            ENABLE ROW LEVEL SECURITY;

-- Generic "user owns row" policies
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'mail_accounts','messages','contacts','contact_emails','tags',
    'message_tags','contact_tags','drafts','signatures','account_signatures','r2m_state'
  ]) LOOP
    EXECUTE format($f$
      CREATE POLICY %I_select ON %I FOR SELECT USING (user_id = auth.uid());
      CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (user_id = auth.uid());
      CREATE POLICY %I_update ON %I FOR UPDATE USING (user_id = auth.uid());
      CREATE POLICY %I_delete ON %I FOR DELETE USING (user_id = auth.uid());
    $f$, t,t,t,t,t,t,t,t);
  END LOOP;
END$$;

-- Invites: only service role reads; no RLS grant needed besides default deny.
-- (Backend uses service_role key to issue/validate invites.)

-- ─── updated_at triggers ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mail_accounts_updated BEFORE UPDATE ON mail_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
