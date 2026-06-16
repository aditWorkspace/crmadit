// Tunable knobs for the AI cold-email personalization layer. Kept separate
// from constants.ts (the legacy email-batch tool) so the two concerns don't
// tangle. See plan: research → verify → write → claim-check → send.

import type { EvidenceKind } from '@/lib/validation';

// ── Models (cheap DeepSeek for the whole cold pipeline) ────────────────────
// Isolated from the shared WRITER_MODEL/DECIDER_MODEL so the personalization
// layer can run on a cheap model without touching auto-followup / first-reply.
export const COLD_RESEARCH_MODEL = 'deepseek/deepseek-v4-flash'; // extraction + claim-check (JSON)
export const COLD_WRITER_MODEL = 'deepseek/deepseek-v4-flash';   // email prose
// Tried in order if the primary model 429s / 5xxs / is unavailable.
export const COLD_MODEL_FALLBACKS = ['deepseek/deepseek-chat-v3-0324'];

// ── Opener ladder ──────────────────────────────────────────────────────────
// Tier is computed IN CODE from which evidence cards survived verification —
// never asserted by a model. Lower tier number = stronger, more specific opener.
//
// public_complaint is intentionally absent: a complaint can SHARPEN a t1-5
// opener as supporting context, but is never an opener on its own (it would
// read as adversarial). role_based is the tier-6 fallback we inject when no
// usable opener evidence survives.
export const EVIDENCE_KIND_TIER: Record<EvidenceKind, number | null> = {
  person_quote:           1, // direct quote/point about customers, feedback, roadmap, product, prioritization
  person_post:            1, // a post/podcast/talk by the person on the same themes
  company_changelog:      2, // shipped feature / changelog / launch
  company_customer_story: 2, // a published customer story / case study
  company_hiring:         3, // hiring product/support/customer/ops/engineering
  tool_stack:             4, // their actual support/sales/eng tools
  adjacent_tool:          5, // a competing/adjacent tool or prioritization process
  public_complaint:    null, // supporting-only — never an opener
  role_based:             6, // generic fallback, nothing verifiable found
};

// Tier → signal score (0-100). Anchors; tune after a labeling pass.
export const TIER_SCORE: Record<number, number> = {
  1: 95,
  2: 80,
  3: 65,
  4: 55,
  5: 45,
  6: 20,
};

export const ROLE_BASED_TIER = 6;

// ── Worker / draft lifecycle ───────────────────────────────────────────────
export const DRAFT_WORKER_BATCH = 12;           // max drafts claimed per worker tick
export const DRAFT_WORKER_BUDGET_MS = 170_000;  // stop STARTING new drafts past this
// Hard per-draft wall-clock cap. A single slow draft (slow site + retries) must
// never run past the 300s Vercel function limit. 170s budget + 120s cap = ≤290s.
export const PER_DRAFT_TIMEOUT_MS = 120_000;
export const DRAFT_LOCK_DURATION_MS = 5 * 60_000;
export const MAX_DRAFT_ATTEMPTS = 3;            // retryable provider failures before 'failed'
// Backoff per attempt: 1m, 5m, 15m. retry_at = now + this. Index = attempt_count-1.
export const DRAFT_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
// Seed keeps roughly this many ready/in-flight drafts per sender (≈2 days runway
// at 100/day). The seed route enqueues up to this minus current backlog.
export const DRAFT_BUFFER_TARGET_PER_SENDER = 220;
// Default hard ceiling on per-day draft spend; overridable via env.
export const DEFAULT_DRAFT_DAILY_SPEND_CEILING_USD = 25;

// Minimum extractor confidence to accept a Sonar-cited evidence card (one with
// a real source URL + quote that we trust from Perplexity's grounding instead
// of re-scraping). Re-scraping the cited URL silently dropped the hiring /
// scale / funding signals we most want (ATS, LinkedIn, news don't re-fetch),
// so we trust the citation and lean on the URL + sensitive filter + claim-check.
export const MIN_CITED_CONFIDENCE = 0.5;

// ── Company research cache ─────────────────────────────────────────────────
export const COMPANY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ── Firecrawl scrape budget (per lead) ─────────────────────────────────────
// Try the highest-signal pages first; stop once we have enough real text.
export const FIRECRAWL_CANDIDATE_PATHS = [
  '/changelog', '/releases', '/blog', '/careers', '/jobs',
  '/customers', '/case-studies', '/integrations', '/',
] as const;
export const FIRECRAWL_MAX_SCRAPE_ATTEMPTS = 5;
export const FIRECRAWL_MAX_SUCCESS_PAGES = 4;
export const FIRECRAWL_MAX_TOTAL_MARKDOWN_CHARS = 40_000;
export const FIRECRAWL_SCRAPE_TIMEOUT_MS = 12_000;

// Perplexity Sonar request timeout. Without this the fetch can hang forever
// and hold the worker lock (observed: a single call ran 450s+ in testing).
export const SONAR_TIMEOUT_MS = 45_000;

// ── Rough cost estimates (USD) for the spend guard / cost_usd accounting ───
// These are planning numbers; verify against live pricing before scaling.
export const SONAR_CALL_COST_USD = 0.008;
export const FIRECRAWL_SCRAPE_COST_USD = 0.002;
export const LLM_EXTRACT_COST_USD = 0.0006;   // DeepSeek extraction
export const LLM_WRITE_COST_USD = 0.0015;     // Haiku write
export const LLM_CLAIMCHECK_COST_USD = 0.0006;

// ── Email copy rules ───────────────────────────────────────────────────────
export const BODY_MIN_WORDS = 50;
export const BODY_MAX_WORDS = 160;
export const SUBJECT_MAX_WORDS = 6; // "under 6 words" → at most 5

// Phrases that read as corporate cliché or hype. A warm, human greeting like
// "Hope you're doing well." and "I wanted to reach out" are NOW ALLOWED on
// purpose (founder-to-founder tone), so those are deliberately not here. Keep
// this list to the genuinely cringe / salesy tells.
export const FORBIDDEN_PHRASES = [
  'circle back',
  'touch base',
  'pick your brain',
  'synergy',
  // AI "fact -> invented interpretation" tells
  'that kind of',
  'that sort of',
  'usually means',
  'must mean',
  // fake-authenticity / jargon tells
  'genuinely',
  'customer signal',
  'scattered feedback',
  'surface what matters',
  'what customers actually need',
  'uncover insights',
  'prioritize inputs',
  // hype words
  'revolutionize',
  'revolutionary',
  'seamless',
  'supercharge',
  'game-changer',
  'game changer',
  'cutting-edge',
  'cutting edge',
  'best-in-class',
  'world-class',
  'unlock',
  'empower',
] as const;

// Deceptive subject prefixes — a cold email faking an existing thread.
export const DECEPTIVE_SUBJECT_PREFIXES = ['re:', 'fwd:', 'fw:'] as const;

// ── Sensitive / "creepy" content filter (anti-fabrication + decency) ───────
// Any evidence card whose statement/quote trips one of these is dropped before
// it can reach the writer. Business facts are fine; a person's private life is
// not. Enforced in code (verifyEvidence) on top of a prompt instruction.
export const SENSITIVE_TOPIC_PATTERNS: RegExp[] = [
  /\b(wife|husband|spouse|girlfriend|boyfriend|partner|married|divorc|fianc|dating)\b/i,
  /\b(kid|kids|child|children|son|daughter|baby|pregnan|parent|mother|father|family)\b/i,
  /\b(church|mosque|synagogue|temple|christian|muslim|jewish|hindu|buddhis|religio|faith|pray)\b/i,
  /\b(democrat|republican|liberal|conservative|maga|politic|elect|vote|abortion|immigration)\b/i,
  /\b(cancer|diabet|depress|anxiety|therapy|disease|illness|disabilit|surgery|diagnos|mental health)\b/i,
  /\b(lives in|based in [A-Z]|home address|neighborhood|hometown)\b/i,
  /\b(\d{1,2} years old|age \d{2}|born in (19|20)\d\d|birthday)\b/i,
  /\b(gay|lesbian|lgbt|transgender|sexual orientation|gender identity)\b/i,
];
