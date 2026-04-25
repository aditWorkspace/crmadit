-- Phase 13: Granola sync — auto-import call notes from Granola.
-- Two API keys (Adit and Srijay) → backfill all past notes + cron sync new ones.

-- 1) Track which Granola note each transcript came from. Partial unique index
--    so we can dedupe across both founders' API keys when they're both in the
--    same call (each gets their own note record but we only want one transcript).
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS granola_note_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_granola_note_id
  ON transcripts (granola_note_id)
  WHERE granola_note_id IS NOT NULL;

-- 2) Per-key sync cursor. Lets us pull only notes created since last successful
--    sync. Seeded with one row per founder.
CREATE TABLE IF NOT EXISTS granola_sync_state (
  api_key_label TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  notes_imported INTEGER NOT NULL DEFAULT 0,
  notes_skipped INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO granola_sync_state (api_key_label) VALUES
  ('adit'),
  ('srijay')
ON CONFLICT (api_key_label) DO NOTHING;
