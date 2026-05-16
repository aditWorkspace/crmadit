-- 2026-05-16: SENT column on A/B Test tab showed 0 across all variants
-- because email_send_variant_stats_30d sourced from `interactions` —
-- but cold campaign sends are written to `email_send_queue`, not
-- `interactions`. Opens were queried directly from email_send_queue
-- in the API route, which is why opens worked but sent didn't.
--
-- This rewrites the RPC to read from email_send_queue (the source of
-- truth for cold sends) using the per-row replied_at column the
-- ab-rebalance route already relies on. Backwards compatible: same
-- column names, same return type, same grants — only the source
-- table changes.
--
-- Replies: queue rows have a replied_at column the Gmail sync stamps
-- when the recipient replies to the thread. Real-reply vs autoreply
-- filtering happens upstream in the sync's lead reply detection;
-- queue.replied_at is only set for genuine human replies.
CREATE OR REPLACE FUNCTION public.email_send_variant_stats_30d()
RETURNS TABLE (
  variant_id      UUID,
  founder_id      UUID,
  label           TEXT,
  is_active       BOOLEAN,
  sent            BIGINT,
  replied         BIGINT,
  reply_rate_pct  NUMERIC(5,2)
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH sent_counts AS (
    SELECT
      q.template_variant_id AS variant_id,
      COUNT(*) FILTER (WHERE q.status = 'sent') AS sent_n,
      COUNT(*) FILTER (WHERE q.status = 'sent' AND q.replied_at IS NOT NULL) AS replied_n
    FROM email_send_queue q
    WHERE q.template_variant_id IS NOT NULL
      AND q.sent_at > now() - interval '30 days'
    GROUP BY q.template_variant_id
  )
  SELECT
    v.id,
    v.founder_id,
    v.label,
    v.is_active,
    COALESCE(s.sent_n, 0)    AS sent,
    COALESCE(s.replied_n, 0) AS replied,
    CASE WHEN COALESCE(s.sent_n, 0) > 0
         THEN ROUND(100.0 * COALESCE(s.replied_n, 0)::numeric / s.sent_n, 2)
         ELSE 0
    END AS reply_rate_pct
  FROM email_template_variants v
  LEFT JOIN sent_counts s ON s.variant_id = v.id
  ORDER BY reply_rate_pct DESC, sent DESC;
$$;
REVOKE ALL ON FUNCTION public.email_send_variant_stats_30d() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_variant_stats_30d() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_variant_stats_30d() TO service_role;

NOTIFY pgrst, 'reload schema';
