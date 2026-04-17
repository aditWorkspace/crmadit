-- Migration 009: Inbox thread state
--
-- Adds per-thread state (snooze, archive) and per-member read state for the
-- new inbox view built on top of interactions. Keeps gmail_thread_id as the
-- primary key so lookups on the list endpoint are a single indexed fetch.

-- Per-thread state (snooze, archive)
CREATE TABLE IF NOT EXISTS thread_state (
  gmail_thread_id TEXT PRIMARY KEY,
  snoozed_until TIMESTAMPTZ,
  snoozed_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  archived_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thread_state_snoozed_until ON thread_state(snoozed_until)
  WHERE snoozed_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thread_state_archived_at ON thread_state(archived_at)
  WHERE archived_at IS NOT NULL;

-- Per-member read state per thread
CREATE TABLE IF NOT EXISTS thread_read_state (
  gmail_thread_id TEXT NOT NULL,
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_thread_id, team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_read_state_member
  ON thread_read_state(team_member_id, last_read_at DESC);

-- Enable Supabase Realtime on both tables (idempotent: ignore if already subscribed)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE thread_state;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE thread_read_state;
EXCEPTION WHEN others THEN NULL;
END $$;
