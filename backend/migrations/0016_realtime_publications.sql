-- Subscribe Supabase Realtime to the user-data tables so changes made on
-- one device push to every other signed-in device of the same user via
-- WebSocket. RLS still applies on subscription, so the client only
-- receives events for rows it could read directly.
--
-- We intentionally do NOT include `messages` here — high volume, and
-- /bootstrap + the auto-sync poll already deliver new mail. The set
-- below is the "user changed metadata"-tier: vendor toggle, tags,
-- merge/unmerge, drafts, account settings, signatures, r2m state.
--
-- Idempotent: the DO block adds each table only if it is not yet in
-- the publication, so re-running the migration is a no-op.

DO $$
DECLARE
  t text;
BEGIN
  -- Supabase provisions `supabase_realtime` automatically, but be
  -- defensive in case this runs on a clean DB without it.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOR t IN
    SELECT unnest(ARRAY[
      'contacts',
      'contact_emails',
      'tags',
      'message_tags',
      'r2m_state',
      'drafts',
      'draft_attachments',
      'mail_accounts',
      'signatures',
      'account_signatures'
    ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
