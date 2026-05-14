-- Phase: Email open tracking + opener-no-reply follow-up loop.
-- Purely additive.
--
-- Adds to email_send_queue:
--   opened_at        — first FILTERED open (passes UA + timing heuristic)
--   open_count       — total raw pixel hits (incl. pre-fetches)
--   replied_at       — denormalized from leads.first_reply_at; sync.ts populates
--                       this when an inbound reply matches a queue row by
--                       gmail_thread_id. Lets the follow-up selector be a single
--                       table WHERE-clause instead of a join.
--   followed_up_at   — when we sent a bump email for this row; prevents the
--                       selector from picking the same row twice.
--   parent_queue_id  — FK back to the original send. NULL on first-touches;
--                       non-NULL on follow-up sends. tick.ts uses presence to
--                       branch sendCampaignEmail vs sendReplyInThread.
--
-- Adds to email_template_variants:
--   is_followup      — TRUE for the bump-message variants. Excluded from the
--                       fresh-cold variant pool (start.ts step ⑧) and included
--                       in the follow-up variant pool (step ⑤a).

ALTER TABLE email_send_queue
  ADD COLUMN IF NOT EXISTS opened_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS open_count       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followed_up_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_queue_id  UUID REFERENCES email_send_queue(id) ON DELETE SET NULL;

-- Partial index for the daily follow-up selector. Hot path: per founder,
-- find rows that opened ≥3d ago, never replied, never followed up.
CREATE INDEX IF NOT EXISTS idx_queue_followup_candidates
  ON email_send_queue (account_id, sent_at)
  WHERE parent_queue_id IS NULL
    AND opened_at IS NOT NULL
    AND replied_at IS NULL
    AND followed_up_at IS NULL;

-- Lets the analytics tab efficiently aggregate opens per variant.
CREATE INDEX IF NOT EXISTS idx_queue_opened_per_variant
  ON email_send_queue (template_variant_id)
  WHERE opened_at IS NOT NULL;

ALTER TABLE email_template_variants
  ADD COLUMN IF NOT EXISTS is_followup BOOLEAN NOT NULL DEFAULT FALSE;
