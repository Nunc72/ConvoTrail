-- Migration 0013: reset unsubscribe_url='' for recent incoming mail
-- so the backfill picks them up again under the new body-html
-- fallback parser.
--
-- v0.0.134 introduced backfill with a header-only parser. Many
-- commercial newsletters (Technische Unie, etc.) skip the
-- List-Unsubscribe header entirely and only embed an unsubscribe
-- link in the HTML body. The new parser scans body_html as a
-- fallback, so we need to re-check the messages that were
-- previously marked "no header" (unsubscribe_url = '').

UPDATE messages
   SET unsubscribe_url = NULL
 WHERE unsubscribe_url = ''
   AND direction = 'in'
   AND date > NOW() - INTERVAL '30 days';
