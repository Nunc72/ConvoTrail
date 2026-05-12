-- Migration 0012: reset unsubscribe_url='' rows so the backfill picks
-- them up under the new (more tolerant) parser.
--
-- The first backfill pass (0010+sync.ts in v0.0.134) used a strict
-- parser that required RFC-compliant <url> angle brackets. Real-world
-- senders sometimes ship bare URLs without brackets, so we missed
-- those. The parser is now tolerant of both forms — but every message
-- the old parser had inspected is already marked as "checked, no
-- header" (unsubscribe_url = '') and would never be re-checked.
--
-- Scope: incoming mail from the last 30 days only. That's where
-- newsletters live, and it keeps the re-check work bounded (a couple
-- of sync cycles at 100/folder).

UPDATE messages
   SET unsubscribe_url = NULL
 WHERE unsubscribe_url = ''
   AND direction = 'in'
   AND date > NOW() - INTERVAL '30 days';
