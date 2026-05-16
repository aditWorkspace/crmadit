-- Background enrichment jobs.
--
-- Replaces the SSE-streaming /enrich-upload route with a persistent
-- job model so users can close the tab and the work continues
-- server-side. Worker is hit by cron-job.org every minute.
--
-- enrich_jobs: one row per upload. Aggregate counters + status.
-- enrich_job_rows: per-CSV-row tracking. Stores the candidate emails
-- we tried, the BEC verdicts, the Icypeas outcome, the final email.
-- The worker reads pending rows in row_index order; the live modal
-- polls /enrich/status which returns the most recently processed
-- rows for the terminal log.

CREATE TABLE IF NOT EXISTS enrich_jobs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by             UUID REFERENCES team_members(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                 TEXT NOT NULL DEFAULT 'queued',
  mode                   TEXT NOT NULL,
  file_name              TEXT,
  total_rows             INT NOT NULL DEFAULT 0,
  processed              INT NOT NULL DEFAULT 0,
  kept                   INT NOT NULL DEFAULT 0,
  dropped                INT NOT NULL DEFAULT 0,
  bec_calls              INT NOT NULL DEFAULT 0,
  icypeas_calls          INT NOT NULL DEFAULT 0,
  cost_usd               NUMERIC(10,4) NOT NULL DEFAULT 0,
  inserted_to_pool       INT NOT NULL DEFAULT 0,
  already_in_pool        INT NOT NULL DEFAULT 0,
  already_blacklisted    INT NOT NULL DEFAULT 0,
  pool_size_before       INT,
  pool_size_after        INT,
  last_error             TEXT,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  worker_locked_until    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_enrich_jobs_status_lock
  ON enrich_jobs (status, worker_locked_until)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_enrich_jobs_recent
  ON enrich_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS enrich_job_rows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES enrich_jobs(id) ON DELETE CASCADE,
  row_index              INT NOT NULL,
  first_name             TEXT,
  full_name              TEXT,
  company                TEXT,
  domain                 TEXT,
  given_email            TEXT,
  candidates_tried       JSONB,
  final_email            TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  bec_passes             INT NOT NULL DEFAULT 0,
  bec_fails              INT NOT NULL DEFAULT 0,
  icypeas_status         TEXT,
  drop_reason            TEXT,
  processed_at           TIMESTAMPTZ,
  UNIQUE (job_id, row_index)
);
CREATE INDEX IF NOT EXISTS idx_enrich_job_rows_pending
  ON enrich_job_rows (job_id, row_index)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrich_job_rows_recent
  ON enrich_job_rows (job_id, processed_at DESC);
