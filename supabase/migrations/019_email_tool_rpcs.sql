-- Phase 16 PR 3: SECURITY DEFINER helpers for the email-tool flow.
-- Two RPC functions called from the API routes, scoped to service_role.
--
-- Why functions instead of inline SQL from the API:
--   1) PostgREST doesn't expose `NOT EXISTS (subquery)` natively, so the
--      pick has to be a function anyway.
--   2) The commit phase has 4 writes (advance pointer, blacklist insert,
--      history insert, cooldown set) that must be atomic — a failure
--      between them would leave the pointer ahead of the blacklist.
--      A PL/pgSQL function is its own implicit transaction; if any
--      INSERT/UPDATE inside fails, the whole thing rolls back.

-- Pick the next batch of pool rows. Read-only.
CREATE OR REPLACE FUNCTION public.email_tool_pick_batch(p_limit INT DEFAULT 400)
RETURNS TABLE (
  id         UUID,
  sequence   INT,
  company    TEXT,
  full_name  TEXT,
  email      TEXT,
  first_name TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.sequence, p.company, p.full_name, p.email, p.first_name
  FROM email_pool p
  WHERE p.sequence >= (SELECT next_sequence FROM email_pool_state WHERE id = 1)
    AND NOT EXISTS (SELECT 1 FROM email_blacklist b WHERE b.email = p.email)
  ORDER BY p.sequence
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.email_tool_pick_batch(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_tool_pick_batch(INT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_tool_pick_batch(INT) TO service_role;

-- Commit a batch atomically. Called AFTER sheet creation succeeded; the
-- caller passes the picked rows' emails + max sequence + sheet metadata
-- and we do all the writes in one txn:
--   1) Add picked emails to blacklist (ON CONFLICT DO NOTHING).
--   2) Recompute fresh-remaining count against the new pointer.
--   3) Update email_pool_state singleton (next_sequence + cache fields).
--   4) Set the team_member's email_batch_next_at cooldown.
--   5) Insert the email_batch_history row.
-- Returns next_sequence, cooldown_at, fresh_remaining for the API response.
CREATE OR REPLACE FUNCTION public.email_tool_commit_batch(
  p_team_member_id UUID,
  p_picked_emails  TEXT[],
  p_max_sequence   INT,
  p_sheet_url      TEXT,
  p_sheet_title    TEXT,
  p_cooldown_hours INT DEFAULT 12
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_next_sequence INT;
  new_cooldown_at   TIMESTAMPTZ;
  fresh_count       INT;
BEGIN
  new_next_sequence := p_max_sequence + 1;
  new_cooldown_at   := now() + (p_cooldown_hours || ' hours')::interval;

  INSERT INTO email_blacklist (email)
  SELECT lower(e) FROM unnest(p_picked_emails) e
  ON CONFLICT (email) DO NOTHING;

  SELECT COUNT(*) INTO fresh_count
  FROM email_pool p
  WHERE p.sequence >= new_next_sequence
    AND NOT EXISTS (SELECT 1 FROM email_blacklist b WHERE b.email = p.email);

  UPDATE email_pool_state
  SET next_sequence       = new_next_sequence,
      eff_remaining_seq   = new_next_sequence,
      eff_remaining_fresh = fresh_count,
      eff_updated_at      = now()
  WHERE id = 1;

  UPDATE team_members
  SET email_batch_next_at = new_cooldown_at
  WHERE id = p_team_member_id;

  INSERT INTO email_batch_history (team_member_id, sheet_url, sheet_title)
  VALUES (p_team_member_id, p_sheet_url, p_sheet_title);

  RETURN jsonb_build_object(
    'next_sequence',   new_next_sequence,
    'cooldown_at',     new_cooldown_at,
    'fresh_remaining', fresh_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.email_tool_commit_batch(UUID, TEXT[], INT, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_tool_commit_batch(UUID, TEXT[], INT, TEXT, TEXT, INT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_tool_commit_batch(UUID, TEXT[], INT, TEXT, TEXT, INT) TO service_role;

-- Helper: count of fresh-remaining at current pointer. Used by the
-- dashboard for the "N emails left in pool" line.
CREATE OR REPLACE FUNCTION public.email_tool_fresh_remaining()
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::int
  FROM email_pool p
  WHERE p.sequence >= (SELECT next_sequence FROM email_pool_state WHERE id = 1)
    AND NOT EXISTS (SELECT 1 FROM email_blacklist b WHERE b.email = p.email);
$$;

REVOKE ALL ON FUNCTION public.email_tool_fresh_remaining() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_tool_fresh_remaining() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_tool_fresh_remaining() TO service_role;
