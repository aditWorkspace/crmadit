-- Phase 18: AI cold-email personalization layer. Pure additive — no drops,
-- no destructive changes. See plan: research → verify → write → claim-check.
--
-- New tables:
--   cold_email_drafts       — one row per (pool lead × sender). The personalized
--                             email + its verified evidence + tier/score. Drained
--                             into email_send_queue by runDailyStart only when
--                             status='ready'. Row-level worker lock (no parent job
--                             table — each draft is one self-contained unit of work).
--   company_research_cache  — per-domain scrape + company-level research cache so
--                             multiple contacts at the same company don't re-scrape.
--
-- Columns added to email_send_queue (snapshot at daily-start; frozen for the send):
--   personalized_draft_id, personalized_subject, personalized_body,
--   personalization_tier, personalization_score
--
-- email_template_variants.audience CHECK widened to allow 'personalized' (the
-- inactive sentinel variant each sender carries only to satisfy the queue's
-- NOT-NULL template_variant_id FK — its templates are never rendered because
-- the personalized_* snapshot takes precedence at send time).

-- ── 1) Drafts ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cold_email_drafts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id               UUID NOT NULL REFERENCES email_pool(id) ON DELETE CASCADE,
  sender_account_id     UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  -- null until consumed; set to the day's campaign when a queue row is built
  campaign_id           UUID REFERENCES email_send_campaigns(id) ON DELETE SET NULL,

  -- lead snapshot (pool rows are effectively immutable, but copy so a draft
  -- is self-contained for debugging / the engine)
  email                 TEXT NOT NULL,
  first_name            TEXT,
  full_name             TEXT,
  company               TEXT,
  domain                TEXT,

  -- sender snapshot (the writer signs off as this founder)
  sender_name           TEXT NOT NULL,
  sender_email          TEXT NOT NULL,

  -- queued | researching | verifying_evidence | writing | checking | ready
  --        | consumed | skipped | failed
  status                TEXT NOT NULL DEFAULT 'queued',
  attempt_count         INT NOT NULL DEFAULT 0,
  -- gates re-pick of 'queued' rows after a retryable provider failure
  retry_at              TIMESTAMPTZ,

  -- research output
  evidence_cards        JSONB,          -- ALL candidate cards incl. rejected (with reject_reason)
  selected_evidence_ids TEXT[],         -- ids of the cards actually handed to the writer
  opener_tier           INT,            -- 1..6, computed in code (never the model)
  signal_score          INT,            -- 0..100, computed in code

  -- email output
  subject               TEXT,
  body                  TEXT,

  -- bookkeeping
  research_model        TEXT,
  decider_model         TEXT,
  writer_model          TEXT,
  cost_usd              NUMERIC(10,4) NOT NULL DEFAULT 0,
  skip_reason           TEXT,           -- when status='skipped'
  error                 TEXT,           -- when status='failed'
  worker_locked_until   TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  researched_at         TIMESTAMPTZ,
  written_at            TIMESTAMPTZ,
  ready_at              TIMESTAMPTZ,
  consumed_at           TIMESTAMPTZ,

  -- One draft per lead per sender. Seed uses ON CONFLICT DO NOTHING on this.
  UNIQUE (pool_id, sender_account_id)
);

-- Worker claim hot-path: queued rows whose lock + retry gate have cleared.
CREATE INDEX IF NOT EXISTS idx_cold_drafts_claimable
  ON cold_email_drafts (status, retry_at, worker_locked_until)
  WHERE status = 'queued';

-- runDailyStart hot-path: highest-signal ready drafts per sender first.
CREATE INDEX IF NOT EXISTS idx_cold_drafts_ready
  ON cold_email_drafts (sender_account_id, signal_score DESC)
  WHERE status = 'ready';

-- ── 2) Company research cache ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_research_cache (
  domain            TEXT PRIMARY KEY,
  scraped_pages     JSONB,        -- [{ url, markdown }]
  company_research  TEXT,         -- company-level Sonar prose (person research is NOT cached)
  citations         JSONB,        -- string[]
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  cached_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3) email_send_queue snapshot columns ───────────────────────────────────
ALTER TABLE email_send_queue
  ADD COLUMN IF NOT EXISTS personalized_draft_id UUID REFERENCES cold_email_drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS personalized_subject  TEXT,
  ADD COLUMN IF NOT EXISTS personalized_body     TEXT,
  ADD COLUMN IF NOT EXISTS personalization_tier  INT,
  ADD COLUMN IF NOT EXISTS personalization_score INT;

-- ── 4) Seed one inactive sentinel variant per active sender ────────────────
-- is_active=false → excluded from start.ts step ⑧ variant pick and from
-- A/B analytics. Personalized queue rows reference it only to satisfy the
-- NOT-NULL FK; tick renders personalized_subject/body, never these templates.
-- Uses audience='general' (an already-allowed value) so this migration needs
-- no CHECK-constraint change; start.ts finds it by its label, not its audience.
INSERT INTO email_template_variants (id, founder_id, label, subject_template, body_template, is_active, is_followup, audience)
SELECT gen_random_uuid(), tm.id, 'adit-personalized-sentinel',
  'personalized', 'personalized — body is snapshotted per-draft onto the queue row',
  false, false, 'general'
FROM team_members tm
WHERE tm.name = 'Adit'
  AND NOT EXISTS (SELECT 1 FROM email_template_variants v WHERE v.label = 'adit-personalized-sentinel');

INSERT INTO email_template_variants (id, founder_id, label, subject_template, body_template, is_active, is_followup, audience)
SELECT gen_random_uuid(), tm.id, 'asim-personalized-sentinel',
  'personalized', 'personalized — body is snapshotted per-draft onto the queue row',
  false, false, 'general'
FROM team_members tm
WHERE tm.name = 'Asim'
  AND NOT EXISTS (SELECT 1 FROM email_template_variants v WHERE v.label = 'asim-personalized-sentinel');

-- Refresh PostgREST schema cache so the new tables/columns are exposed now.
NOTIFY pgrst, 'reload schema';
