-- 2026-05-16: split outreach by audience. YC batch leads (have a value
-- in the new yc_batch column) go through the existing 4-variant A/B
-- test rotation; non-YC leads use a single "product prioritization"
-- template per founder that does not participate in A/B.
--
-- Additive only:
--   1. yc_batch column on email_pool / email_send_queue / enrich_job_rows
--   2. audience column on email_template_variants (default 'yc' so all
--      existing active variants keep their behavior)
--   3. Two new 'general'-audience variants — product prioritization
--      copy adapted from Srijay's original (now inactive). Adit and
--      Asim each get one. is_active=true so they're picked up by the
--      send pipeline.
--
-- Reverting is also additive-friendly: drop the columns + delete the
-- two new rows (or just toggle their is_active to false). No data loss
-- on existing rows because the new column is nullable / has a default.

ALTER TABLE email_pool        ADD COLUMN IF NOT EXISTS yc_batch TEXT;
ALTER TABLE email_send_queue  ADD COLUMN IF NOT EXISTS yc_batch TEXT;
ALTER TABLE enrich_job_rows   ADD COLUMN IF NOT EXISTS yc_batch TEXT;

-- audience: 'yc' (default — A/B test rotation) | 'general' (single template).
-- Default 'yc' keeps all existing active variants behaving as today.
ALTER TABLE email_template_variants
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'yc'
  CHECK (audience IN ('yc', 'general'));

-- Two new "product prioritization" variants — one per active founder.
-- Insert idempotently: skip if a variant with the same label already
-- exists (re-running this migration is safe).
INSERT INTO email_template_variants (id, founder_id, label, subject_template, body_template, is_active, is_followup, audience)
SELECT
  gen_random_uuid(),
  tm.id,
  'adit-general-product-prioritization',
  'product prioritization at {{company}}',
  E'Hi {{first_name}},\n\nMy name is Adit and I''m a Berkeley CS student building proxitest.com — a product prioritization tool that turns scattered customer signals (calls, tickets, slack, github) into structured, prioritized issues.\n\nI''m reaching out because {{company}} caught my attention, and I''d love to learn how you decide what product work to prioritize when there are competing signals.\n\nAny chance you''d be open to a quick 10-15 min chat sometime next week?\n\nBest,\nAdit',
  true,
  false,
  'general'
FROM team_members tm
WHERE tm.name = 'Adit'
  AND NOT EXISTS (
    SELECT 1 FROM email_template_variants v
    WHERE v.label = 'adit-general-product-prioritization'
  );

INSERT INTO email_template_variants (id, founder_id, label, subject_template, body_template, is_active, is_followup, audience)
SELECT
  gen_random_uuid(),
  tm.id,
  'asim-general-product-prioritization',
  'product prioritization at {{company}}',
  E'Hi {{first_name}},\n\nMy name is Asim and I''m studying CS at Berkeley. I''m building proxitest.com — a product prioritization tool that turns scattered customer signals (calls, tickets, slack, github) into structured, prioritized issues.\n\nI''m reaching out because {{company}} caught my attention, and I''d love to learn how you think about product prioritization when there are competing signals from users, analytics, and internal teams.\n\nAny chance you''d be open to a quick 10-15 min chat sometime next week?\n\nBest,\nAsim',
  true,
  false,
  'general'
FROM team_members tm
WHERE tm.name = 'Asim'
  AND NOT EXISTS (
    SELECT 1 FROM email_template_variants v
    WHERE v.label = 'asim-general-product-prioritization'
  );

-- Refresh PostgREST schema cache so the new columns are exposed
-- immediately without needing a project restart.
NOTIFY pgrst, 'reload schema';
