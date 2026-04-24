-- Phase 12: Insights Chat debate architecture — full-text search over transcripts
-- Adds a generated tsvector combining raw_text + ai_summary + stringified JSONB AI fields,
-- plus a GIN index for ts_rank retrieval. No embeddings; FTS only.

-- Helper: flatten a JSONB array of objects into a single whitespace-joined text blob.
-- Used on ai_pain_points, ai_product_feedback, ai_key_quotes so their English content
-- (not the JSON keys) is searchable.
CREATE OR REPLACE FUNCTION public.jsonb_texts(j JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    string_agg(
      -- concatenate every string value inside each object
      (SELECT string_agg(v::text, ' ') FROM jsonb_each_text(elem) AS kv(k, v)),
      ' '
    ),
    ''
  )
  FROM jsonb_array_elements(COALESCE(j, '[]'::jsonb)) AS elem
$$;

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(ai_summary, '')), 'A') ||
    setweight(to_tsvector('english', public.jsonb_texts(ai_pain_points)), 'A') ||
    setweight(to_tsvector('english', public.jsonb_texts(ai_product_feedback)), 'A') ||
    setweight(to_tsvector('english', public.jsonb_texts(ai_key_quotes)), 'B') ||
    setweight(to_tsvector('english', COALESCE(ai_next_steps, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(raw_text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_transcripts_fts ON transcripts USING GIN (fts);
