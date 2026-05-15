-- One-day adaptive A/B test idempotency marker.
-- Set by /api/cron/email-tool/ab-rebalance on first successful run; later
-- hits on the same campaign no-op. Nullable; nothing else reads this
-- column. Purely additive.

ALTER TABLE email_send_campaigns
  ADD COLUMN IF NOT EXISTS ab_rebalance_done_at TIMESTAMPTZ;
