-- Phase 16: Email Tool absorption.
-- Schema for the email-batching tool ported from the standalone
-- emailsending repo. Pure additive — no drops, no destructive changes.
--
-- Tables:
--   email_pool         — the cold-outreach pool (~24k rows from CSV row 4214 onwards)
--   email_blacklist    — anti-double-contact set (5944 seed rows)
--   email_pool_state   — singleton row holding the next-sequence pointer + cache
--   email_batch_history — per-user batch log (replaces Redis history:<pin>)
--
-- Columns added to team_members:
--   is_admin               — gates blacklist upload + all-users history view
--   email_batch_next_at    — replaces Redis cooldown:<pin> (12h between batches)
--
-- Lookup pattern (replacing Upstash SMISMEMBER + 500-row lookahead):
--   SELECT p.* FROM email_pool p
--   LEFT JOIN email_blacklist b ON p.email = b.email
--   WHERE p.sequence >= $next_sequence AND b.email IS NULL
--   ORDER BY p.sequence
--   LIMIT 400
-- Both join keys are CHECK-constrained to lowercase so the join is a
-- straight equality (no lower() function on either side).

CREATE TABLE IF NOT EXISTS email_pool (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence     INT NOT NULL,
  company      TEXT,
  full_name    TEXT,
  email        TEXT NOT NULL CHECK (email = lower(email)),
  first_name   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_pool_sequence ON email_pool (sequence);
-- Email index intentionally NOT unique — the source CSV may contain
-- duplicates, and the blacklist is the safety net for double-shipping.
CREATE INDEX IF NOT EXISTS idx_email_pool_email ON email_pool (email);

CREATE TABLE IF NOT EXISTS email_blacklist (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Singleton state row — id is constrained to 1 so there can only ever be
-- one row. Replaces Redis `pointer` and `effective_remaining` keys.
CREATE TABLE IF NOT EXISTS email_pool_state (
  id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_sequence       INT NOT NULL DEFAULT 0,
  eff_remaining_seq   INT,
  eff_remaining_fresh INT,
  eff_updated_at      TIMESTAMPTZ
);

INSERT INTO email_pool_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS email_batch_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id  UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  sheet_url       TEXT NOT NULL,
  sheet_title     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_batch_history_team_member
  ON email_batch_history (team_member_id, created_at DESC);

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS email_batch_next_at TIMESTAMPTZ;
