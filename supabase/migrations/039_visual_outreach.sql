-- 039_visual_outreach.sql
-- Visual Outreach v2: short email + per-person AI-edited whiteboard image +
-- auto-generated personal landing page. Replaces the text-only research path.
-- ADDITIVE ONLY (new columns / table / bucket / policy). No drops, no narrowing.
-- See plan: scrape industry -> image edit -> HTML email + landing page.

-- ── 1) cold_email_drafts: v2 output fields ─────────────────────────────────
-- industry/image_url/page_slug + the prebuilt email HTML carried to send time.
ALTER TABLE cold_email_drafts
  ADD COLUMN IF NOT EXISTS industry   TEXT,
  ADD COLUMN IF NOT EXISTS image_url  TEXT,
  ADD COLUMN IF NOT EXISTS page_slug  TEXT,
  ADD COLUMN IF NOT EXISTS email_html TEXT;

-- ── 2) email_send_queue: carry prebuilt HTML + image through to the wire ────
ALTER TABLE email_send_queue
  ADD COLUMN IF NOT EXISTS personalized_html TEXT,
  ADD COLUMN IF NOT EXISTS image_url         TEXT;

-- ── 3) company_research_cache: cache the resolved industry per domain ───────
ALTER TABLE company_research_cache
  ADD COLUMN IF NOT EXISTS industry TEXT;

-- ── 4) landing_pages: one row per recipient, rendered by the landing-site ───
CREATE TABLE IF NOT EXISTS landing_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  draft_id        UUID REFERENCES cold_email_drafts(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  first_name      TEXT,
  company         TEXT,
  industry        TEXT,
  image_url       TEXT,
  headline        TEXT,
  subline         TEXT,
  blurb           TEXT,
  cal_url         TEXT NOT NULL DEFAULT 'https://cal.com/adit-mittal/30min',
  sender_name     TEXT,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landing_pages_slug ON landing_pages (slug);

-- RLS enabled with NO public policy. This table holds recipient PII
-- (recipient_email), so the anon/publishable keys must NOT be able to read it
-- (a USING(true) policy would let anyone harvest the whole prospect list).
-- The landing-site renders pages SERVER-SIDE with the service-role key
-- (server-only env, never NEXT_PUBLIC_) and only selects non-PII render
-- columns; the main app writes with the service role. Both bypass RLS.
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;

-- ── 5) Public Storage bucket for the generated whiteboard images ────────────
-- Serves the same URL to both the email <img src> and the landing page.
INSERT INTO storage.buckets (id, name, public)
VALUES ('outreach-images', 'outreach-images', true)
ON CONFLICT (id) DO NOTHING;
