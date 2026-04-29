-- PR 6 (post-PR-5 hardening) — adds three columns to `email_send_queue`
-- so we can preserve the rendered email content + gmail thread id at send
-- time. This unblocks the lead-on-reply policy:
--
--   * runDailyStart no longer creates a lead row at send time. Sends are
--     persisted only in `email_send_queue`.
--   * When a recipient REPLIES, gmail/sync.ts looks up the queue row by
--     gmail_thread_id, uses `rendered_subject` + `rendered_body` to
--     backfill the outbound `interactions` row, sets
--     `leads.source_campaign_id` for attribution, and creates the lead at
--     stage='replied' — all driven by an actual reply, not a send.
--
-- All additions are pure-additive (NULL-able + `IF NOT EXISTS` guards) so
-- the migration is safe to re-run and doesn't trip the literal-token
-- guard.

ALTER TABLE public.email_send_queue
  ADD COLUMN IF NOT EXISTS rendered_subject TEXT,
  ADD COLUMN IF NOT EXISTS rendered_body    TEXT,
  ADD COLUMN IF NOT EXISTS gmail_thread_id  TEXT;

-- Index supports the reply-side lookup: given a gmail thread, find the
-- send. Partial index keeps it cheap (most rows pre-send have no thread
-- id).
CREATE INDEX IF NOT EXISTS email_send_queue_gmail_thread_id_idx
  ON public.email_send_queue (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
