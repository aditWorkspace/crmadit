-- PR 5 Task 5.3: analytics RPCs for the Overview tab + daily digest.
-- Pure additive — three SECURITY DEFINER functions, service_role only.

-- ── 1) Per-variant 30-day stats ──────────────────────────────────────────
-- Returns one row per variant with sent count + replied count + reply_rate.
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
      i.template_variant_id AS variant_id,
      COUNT(*) AS sent_n,
      COUNT(DISTINCT l.id) FILTER (WHERE l.first_reply_at IS NOT NULL) AS replied_n
    FROM interactions i
    LEFT JOIN leads l ON l.id = i.lead_id
    WHERE i.template_variant_id IS NOT NULL
      AND i.type = 'email_outbound'
      AND i.occurred_at > now() - interval '30 days'
    GROUP BY i.template_variant_id
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

-- ── 2) Per-founder today + last-7d send counts ──────────────────────────
-- Returns JSONB { today_sent, week_sent, today_failed, today_skipped }.
CREATE OR REPLACE FUNCTION public.email_send_founder_stats_today(p_founder_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH today_pt AS (
    SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS today
  ),
  stats AS (
    SELECT
      COUNT(*) FILTER (
        WHERE q.status = 'sent'
        AND (q.sent_at AT TIME ZONE 'America/Los_Angeles')::date = (SELECT today FROM today_pt)
      ) AS today_sent,
      COUNT(*) FILTER (
        WHERE q.status = 'sent' AND q.sent_at > now() - interval '7 days'
      ) AS week_sent,
      COUNT(*) FILTER (
        WHERE q.status = 'failed'
        AND (q.created_at AT TIME ZONE 'America/Los_Angeles')::date = (SELECT today FROM today_pt)
      ) AS today_failed,
      COUNT(*) FILTER (
        WHERE q.status = 'skipped'
        AND (q.created_at AT TIME ZONE 'America/Los_Angeles')::date = (SELECT today FROM today_pt)
      ) AS today_skipped
    FROM email_send_queue q
    WHERE q.account_id = p_founder_id
  )
  SELECT jsonb_build_object(
    'today_sent',    today_sent,
    'week_sent',     week_sent,
    'today_failed',  today_failed,
    'today_skipped', today_skipped
  )
  FROM stats;
$$;
REVOKE ALL ON FUNCTION public.email_send_founder_stats_today(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_founder_stats_today(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_founder_stats_today(UUID) TO service_role;

-- ── 3) Per-founder reply-rate over last 30 days ──────────────────────────
-- Used by Overview tab "reply rate" column. Returns JSONB.
CREATE OR REPLACE FUNCTION public.email_send_founder_reply_rate_30d(p_founder_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH stats AS (
    SELECT
      COUNT(*) AS sent_n,
      COUNT(DISTINCT l.id) FILTER (WHERE l.first_reply_at IS NOT NULL) AS replied_n
    FROM interactions i
    LEFT JOIN leads l ON l.id = i.lead_id
    WHERE i.team_member_id = p_founder_id
      AND i.type = 'email_outbound'
      AND i.campaign_id IS NOT NULL
      AND i.occurred_at > now() - interval '30 days'
  )
  SELECT jsonb_build_object(
    'sent_30d',     sent_n,
    'replied_30d',  replied_n,
    'reply_rate_pct',
      CASE WHEN sent_n > 0 THEN ROUND(100.0 * replied_n::numeric / sent_n, 2) ELSE 0 END
  )
  FROM stats;
$$;
REVOKE ALL ON FUNCTION public.email_send_founder_reply_rate_30d(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_founder_reply_rate_30d(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_founder_reply_rate_30d(UUID) TO service_role;
