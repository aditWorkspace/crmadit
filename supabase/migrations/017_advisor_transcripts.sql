-- Phase 15: Advisor / misc-call transcripts.
-- These are calls where there's no CRM lead — advisor calls, founder
-- mentor sessions, etc. We share the existing `transcripts` table rather
-- than creating a separate one so the AI processor, FTS, insights chat,
-- and zip export pick them up automatically.

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'customer_call'
    CHECK (kind IN ('customer_call', 'advisor_call', 'misc'));

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS participant_name TEXT;

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS participant_context TEXT;

CREATE INDEX IF NOT EXISTS idx_transcripts_kind ON transcripts (kind);
