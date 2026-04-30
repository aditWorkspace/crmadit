-- HOTFIX 2026-04-29: production /api/pipeline returning 500 with
-- "invalid input value for enum lead_stage: outreach_sent".
--
-- Migration 023 commented "leads.stage is unconstrained TEXT today" — that
-- was wrong. The actual production schema has `stage` as a Postgres ENUM
-- type named `lead_stage`. PR 4 added `'outreach_sent'` to the TypeScript
-- LeadStage union but never to the DB enum, so every query that filters by
-- ACTIVE_STAGES (which includes `outreach_sent`) crashes the moment Postgres
-- tries to cast the literal to the enum.
--
-- This migration adds the value. Pure additive — no existing rows need to
-- change. ALTER TYPE ADD VALUE IF NOT EXISTS is idempotent (safe to re-run).

ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'outreach_sent';
