-- 041: A/B test dimension for the visual cold-email pipeline.
-- 3 email variants (A/B/C) differ in subject + intro copy (same image, same
-- landing page). Tagging each send with its variant makes per-variant
-- open-rate / reply-rate a simple GROUP BY on email_send_queue.
--
-- Additive only.
ALTER TABLE cold_email_drafts ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT 'A';
-- nullable on the queue: null for follow-up / priority rows, set for visual fresh sends.
ALTER TABLE email_send_queue ADD COLUMN IF NOT EXISTS variant TEXT;
