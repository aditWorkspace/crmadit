-- 2026-05-03 — soft-delete pattern for team_members.
--
-- Adds a `departed_at` timestamp so we can mark a founder as "no longer
-- active" without deleting their row (which would cascade through ~1000+
-- foreign-key references in leads, interactions, email_send_queue, etc.
-- and lose history we explicitly want to preserve).
--
-- Active operations (runDailyStart, runTick, cron email-sync, auto-
-- followup, priority CSV upload domain routing, user-selector modal) all
-- filter `departed_at IS NULL` in code. Read-only views (lead detail,
-- pipeline filter tabs) still display departed founders so historical
-- attribution is visible.
--
-- ── Reversibility ───────────────────────────────────────────────────────
-- This change is fully reversible without losing data. To re-instate a
-- founder (e.g., they come back):
--
--   UPDATE team_members SET
--     departed_at         = NULL,
--     email_send_paused   = false,
--     -- gmail tokens must be re-OAuth'd via /settings (encrypted nulls
--     --  cleared at departure cannot be restored from disk)
--     -- granola key must be re-added to Vercel env
--   WHERE id = '<founder-id>';
--
--   UPDATE email_template_variants SET is_active = true
--   WHERE founder_id = '<founder-id>' AND <selected variants>;
--
-- After that, the founder reappears in the team selector, daily-start
-- picks their account again, and cron email-sync resumes (after they
-- re-OAuth their Gmail).

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS departed_at TIMESTAMPTZ;

-- Partial index optimizes the common query: "give me all active founders".
-- For 3-row team it's overkill on read time, but right-size for clarity.
CREATE INDEX IF NOT EXISTS team_members_active_idx
  ON team_members (id) WHERE departed_at IS NULL;
