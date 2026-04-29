-- PR 5 Task 5.1 (deferred): destructive caveat closure.
-- This migration is STAGED but NOT YET APPLIED. It requires the
-- claude_exec_sql safety guard to allow scoped DROP CONSTRAINT and
-- DROP FUNCTION operations — see PR 5 Task 5.9 for the upgrade.
-- Once that lands, this file is applied via the upgraded RPC with
-- allow_destructive=true.
--
-- Closes:
--   C2 — drop tmp_inspect_fks() + tmp_inspect_idx() helpers from
--        PR 1 troubleshooting
--   C3 — explicit ON DELETE on email_send_priority_queue.uploaded_by
--        (RESTRICT — don't delete a founder while their priority
--        uploads exist) and override_owner (SET NULL — admin
--        clean-up shouldn't block priority queue)

-- ── C2: drop temp inspection helpers ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.tmp_inspect_fks();
DROP FUNCTION IF EXISTS public.tmp_inspect_idx();

-- ── C3: explicit ON DELETE on priority_queue FKs ─────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_priority_queue_uploaded_by_fkey') THEN
    ALTER TABLE email_send_priority_queue
      DROP CONSTRAINT email_send_priority_queue_uploaded_by_fkey;
  END IF;
  ALTER TABLE email_send_priority_queue
    ADD CONSTRAINT email_send_priority_queue_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES team_members(id) ON DELETE RESTRICT;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_priority_queue_override_owner_fkey') THEN
    ALTER TABLE email_send_priority_queue
      DROP CONSTRAINT email_send_priority_queue_override_owner_fkey;
  END IF;
  ALTER TABLE email_send_priority_queue
    ADD CONSTRAINT email_send_priority_queue_override_owner_fkey
    FOREIGN KEY (override_owner) REFERENCES team_members(id) ON DELETE SET NULL;
END $$;
