-- Phase 17 PR 5 Task 5.9 (PROPOSED — NOT YET APPLIED)
--
-- Upgrades the project's `claude_exec_sql` SECURITY DEFINER function to
-- accept an explicit `allow_destructive boolean DEFAULT false` parameter.
-- When false (default), the existing literal-token guard against DROP /
-- DELETE / TRUNCATE remains in force — every existing caller behaves
-- identically. When true, the guard is bypassed and the SQL runs as-is.
--
-- This is a SAFETY-PRIMITIVE CHANGE. It expands what an authenticated
-- service-role caller can do via a single function. Read this carefully
-- before applying:
--
--   1. The function is gated on the service_role JWT, which is held by
--      our app + the Supabase dashboard + anyone with the env file.
--   2. With allow_destructive=true, this function can drop tables,
--      truncate data, narrowing-alter columns. The literal-token guard
--      was the project's last-line defense against that.
--   3. The user (Adit) explicitly built the guard. Bypassing it should
--      only be available with explicit per-call opt-in.
--
-- Mitigations baked into this design:
--   - allow_destructive defaults to false. Existing callers don't change.
--   - The bypass is per-call, not a session toggle.
--   - Every destructive call should be auditable. We log the SQL body
--      to a new `claude_exec_sql_audit` table so we can grep for past
--      destructive operations. (See below.)
--
-- The companion migration `025a_email_send_destructive_mop_up.sql` is
-- the FIRST consumer of this upgrade — it drops the tmp_inspect_*
-- helpers (C2) and tightens FK ON DELETE on email_send_priority_queue
-- (C3) using DROP CONSTRAINT + ADD CONSTRAINT.
--
-- WHEN TO APPLY: only after Adit has reviewed this file end-to-end and
-- explicitly authorized. NOT applied automatically.

-- Step 1: audit table — every destructive call leaves a trace
CREATE TABLE IF NOT EXISTS public.claude_exec_sql_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  caller_jwt_sub TEXT,
  destructive   BOOLEAN NOT NULL,
  sql_preview   TEXT NOT NULL,         -- first 500 chars of the SQL
  outcome       TEXT NOT NULL,         -- 'ok' | 'rejected_token_guard' | 'sql_error:<msg>'
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS claude_exec_sql_audit_invoked_at_idx
  ON public.claude_exec_sql_audit (invoked_at DESC);

-- Step 2: the upgraded function. Same call signature except for the
-- new optional second arg.
CREATE OR REPLACE FUNCTION public.claude_exec_sql(
  sql_text          TEXT,
  allow_destructive BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_upper      TEXT;
  v_destructive_token_found TEXT;
  v_outcome    TEXT;
  v_err_msg    TEXT;
BEGIN
  v_upper := UPPER(sql_text);

  -- Token guard. Catches literal DROP / DELETE / TRUNCATE.
  -- Only bypassed when caller passes allow_destructive=true.
  IF NOT allow_destructive THEN
    IF v_upper ~ '\bDROP\b' THEN
      v_destructive_token_found := 'drop';
    ELSIF v_upper ~ '\bDELETE\s+FROM\b' THEN
      v_destructive_token_found := 'delete from';
    ELSIF v_upper ~ '\bTRUNCATE\b' THEN
      v_destructive_token_found := 'truncate';
    END IF;

    IF v_destructive_token_found IS NOT NULL THEN
      INSERT INTO public.claude_exec_sql_audit
        (destructive, sql_preview, outcome, error_message)
      VALUES (false, LEFT(sql_text, 500), 'rejected_token_guard',
              'forbidden token: ' || v_destructive_token_found);
      RAISE EXCEPTION 'claude_exec_sql refused: contains forbidden token %', v_destructive_token_found
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Execute
  BEGIN
    EXECUTE sql_text;
    v_outcome := 'ok';
    INSERT INTO public.claude_exec_sql_audit
      (destructive, sql_preview, outcome)
    VALUES (allow_destructive, LEFT(sql_text, 500), 'ok');
    RETURN jsonb_build_object('ok', true);
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    INSERT INTO public.claude_exec_sql_audit
      (destructive, sql_preview, outcome, error_message)
    VALUES (allow_destructive, LEFT(sql_text, 500), 'sql_error', v_err_msg);
    RAISE EXCEPTION '%', v_err_msg USING ERRCODE = SQLSTATE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.claude_exec_sql(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claude_exec_sql(TEXT, BOOLEAN) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claude_exec_sql(TEXT, BOOLEAN) TO service_role;

-- Note: the OLD single-arg overload (sql_text TEXT) is still callable
-- because Postgres treats the new BOOLEAN with DEFAULT as backward-compat.
-- Existing scripts that call claude_exec_sql with one argument continue
-- to work and continue to enforce the token guard.

-- Sanity: this migration itself contains the literal tokens DROP and
-- DELETE FROM in code that is intentionally inert (regex literals +
-- comments). When Adit applies this, they'll need to use the bypass
-- since `claude_exec_sql` will see those tokens. Use the upgraded RPC
-- with allow_destructive=true on the FIRST application. Future
-- applications via CREATE OR REPLACE FUNCTION won't trip the guard
-- because there's no DROP/DELETE in normal pure-additive migrations.
