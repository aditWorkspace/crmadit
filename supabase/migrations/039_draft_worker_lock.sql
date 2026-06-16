-- Phase 18b: global single-runner lock for the cold-email draft worker.
-- The worker now processes drafts at internal concurrency 5 (the Firecrawl
-- Hobby browser limit). To keep overlapping fire-and-forget invocations from
-- stacking past 5 concurrent scrapes, only one worker runs at a time, gated by
-- a CAS on this column. Purely additive (one nullable column on the singleton).

ALTER TABLE email_pool_state
  ADD COLUMN IF NOT EXISTS draft_worker_lock_until TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
