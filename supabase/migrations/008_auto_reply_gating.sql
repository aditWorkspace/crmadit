-- Migration 008: First-reply auto-responder gating flag
--
-- Adds auto_replied_to_first to leads so the new first-reply responder in
-- src/lib/automation/first-reply-responder.ts can guarantee that it touches
-- any given lead at most once. The flag is set to TRUE with a compare-and-set
-- UPDATE before any AI call or Gmail send, and rolled back to FALSE if the
-- classified reply turns out to be an out-of-office auto-reply (so the real
-- human reply can be processed later).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS auto_replied_to_first BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index so the cron's "leads eligible for first-reply processing"
-- query is cheap even as the leads table grows.
CREATE INDEX IF NOT EXISTS idx_leads_auto_reply_pending
  ON leads (stage)
  WHERE stage = 'replied'
    AND auto_replied_to_first = FALSE
    AND is_archived = FALSE;
