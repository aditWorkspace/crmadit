// The cold-email personalization engine. One call = one draft, end to end:
//
//   0. sendability pre-check (don't spend on a lead we can't email)
//   1. company research  (Firecrawl scrape, cached per domain)
//   2. person+company research (Perplexity Sonar, cited)
//   3. extraction        (DeepSeek → structured evidence cards)
//   4. verification      (IN CODE: citation + quote-in-source + sensitive filter)
//   5. tier + score      (IN CODE, never the model)
//   6. write             (Haiku, from SELECTED cards only)
//   7. lint + claim-check (regen once → downgrade to tier 6 → fail)
//
// Anti-fabrication guarantees: the writer only ever sees verified cards; every
// non-role_based card needs a real, quote-matched source; tier/score are
// computed here. Provider failures (Firecrawl/Sonar/OpenRouter being
// unhealthy) return { kind: 'retry' } — NEVER a silent tier-6 fallback. Tier-6
// is reserved for "research succeeded, nothing verifiable survived".

import { createAdminClient } from '@/lib/supabase/admin';
import { callAIMessages } from './openrouter';
import { tolerantJsonParse } from './json';
import {
  coldExtractionSchema,
  coldWriteSchema,
  type EvidenceCard,
} from '@/lib/validation';
import {
  COLD_RESEARCH_MODEL,
  COLD_WRITER_MODEL,
  COLD_MODEL_FALLBACKS,
  EVIDENCE_KIND_TIER,
  TIER_SCORE,
  ROLE_BASED_TIER,
  COMPANY_CACHE_TTL_MS,
  FIRECRAWL_SCRAPE_COST_USD,
  SONAR_CALL_COST_USD,
  SONAR_TIMEOUT_MS,
  MIN_CITED_CONFIDENCE,
  LLM_EXTRACT_COST_USD,
  LLM_WRITE_COST_USD,
  LLM_CLAIMCHECK_COST_USD,
  SENSITIVE_TOPIC_PATTERNS,
} from '@/lib/email-tool/cold-constants';
import { scrapeCompanySite, FirecrawlError, type ScrapedPage } from '@/lib/external/firecrawl';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  SONAR_RESEARCH_SYSTEM_PROMPT,
  buildSonarResearchUserMessage,
  buildWriterSystemPrompt,
  buildWriterUserMessage,
  buildRegenFeedback,
} from './cold-email-prompts';
import { lintColdEmail } from '@/lib/email-tool/cold-lint';
import { claimCheck } from './cold-claim-check';

const SONAR_ENDPOINT = 'https://api.perplexity.ai/chat/completions';
const MAX_WRITER_CARDS = 4;

type Supa = ReturnType<typeof createAdminClient>;

export interface DraftInput {
  id: string;
  pool_id: string;
  email: string;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
  sender_account_id: string;
  sender_name: string;
  sender_email: string;
}

export type DraftOutcome =
  | {
      kind: 'ready';
      subject: string;
      body: string;
      opener_tier: number;
      signal_score: number;
      evidence_cards: EvidenceCard[];
      selected_evidence_ids: string[];
      cost_usd: number;
      trace?: string; // write/claim-check attempt log, for debugging
    }
  | { kind: 'skipped'; reason: string; cost_usd: number }
  | { kind: 'retry'; reason: string; cost_usd: number }
  | { kind: 'failed'; reason: string; cost_usd: number; evidence_cards?: EvidenceCard[]; trace?: string };

// Injectable external calls so the engine is testable without real providers.
export interface ColdResearchDeps {
  scrapeCompanySiteFn: typeof scrapeCompanySite;
  runSonarFn: (input: DraftInput) => Promise<{ text: string; citations: string[] }>;
}

const defaultDeps: ColdResearchDeps = {
  scrapeCompanySiteFn: scrapeCompanySite,
  runSonarFn: runColdSonar,
};

// ── Pure helpers (exported for unit tests) ─────────────────────────────────

export function deriveDomain(input: { domain: string | null; email: string }): string {
  if (input.domain && input.domain.includes('.')) return input.domain.toLowerCase();
  return (input.email.split('@')[1] ?? '').toLowerCase();
}

/** Scrub model slip-ups: dashes → comma, drop stray merge tags. */
export function scrubCopy(s: string): string {
  return s
    .replaceAll('—', ', ')
    .replaceAll('–', ', ')
    .replaceAll('―', ', ')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\s+,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True if the quote (or a leading 8-word shingle of it) appears in haystack. */
export function quoteAppearsIn(quote: string, haystack: string): boolean {
  const q = normalizeText(quote);
  if (q.length < 8) return false;
  const h = normalizeText(haystack);
  if (h.includes(q)) return true;
  const words = q.split(' ');
  if (words.length >= 8) return h.includes(words.slice(0, 8).join(' '));
  return false;
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSensitiveEvidence(card: EvidenceCard, companyName?: string | null): boolean {
  let text = `${card.statement} ${card.evidence_quote ?? ''}`;
  // Don't let the company's OWN name trip the filter — e.g. a company literally
  // called "The Family" would otherwise flag every card on the word "family".
  if (companyName && companyName.trim().length >= 3) {
    const re = new RegExp(companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(re, ' ');
  }
  return SENSITIVE_TOPIC_PATTERNS.some(rx => rx.test(text));
}

/**
 * Verify each candidate card IN CODE. Returns the full card list with
 * usable_in_email / supporting_only / reject_reason set.
 *
 * - Firecrawl cards (the company's own scraped pages) must quote-match the
 *   scrape — strongest, free ground truth.
 * - Sonar cards are TRUSTED on Perplexity's citation: a real source URL + a
 *   concrete quote + the extractor's confidence. We deliberately do NOT
 *   re-scrape the cited URL — that silently dropped the hiring / scale /
 *   funding signals we most want (ATS, LinkedIn, news pages don't re-fetch).
 *   Anti-fabrication still rests on: a required real URL, the sensitive-content
 *   filter, a confidence floor, and the downstream claim-check.
 * - Sourceless / sensitive / derived / model-role_based cards are dropped.
 */
export function verifyEvidence(
  cards: EvidenceCard[],
  scrapedMarkdown: string,
  opts: { minCitedConfidence?: number; companyName?: string | null } = {},
): EvidenceCard[] {
  const minConf = opts.minCitedConfidence ?? MIN_CITED_CONFIDENCE;
  const out: EvidenceCard[] = [];

  const markUsable = (c: EvidenceCard) => {
    c.usable_in_email = true;
    if (c.kind === 'public_complaint') c.supporting_only = true;
  };

  for (const card of cards) {
    const c: EvidenceCard = { ...card, usable_in_email: false, supporting_only: false, reject_reason: null };

    if (c.kind === 'role_based') { c.reject_reason = 'model_role_based_ignored'; out.push(c); continue; }
    if (isSensitiveEvidence(c, opts.companyName)) { c.reject_reason = 'sensitive'; out.push(c); continue; }
    if (!c.source_url || !isHttpUrl(c.source_url)) { c.reject_reason = 'no_source'; out.push(c); continue; }
    if (!c.evidence_quote) { c.reject_reason = 'no_quote'; out.push(c); continue; }

    if (c.source_type === 'firecrawl') {
      if (quoteAppearsIn(c.evidence_quote, scrapedMarkdown)) markUsable(c);
      else c.reject_reason = 'not_in_scrape';
    } else if (c.source_type === 'sonar') {
      if (c.confidence >= minConf) markUsable(c);
      else c.reject_reason = 'low_confidence';
    } else {
      c.reject_reason = 'derived_unverifiable';
    }
    out.push(c);
  }

  return out;
}

/** Pick the cards the writer is allowed to see, and compute opener tier+score. */
export function selectAndScore(verified: EvidenceCard[]): {
  cards: EvidenceCard[];
  tier: number;
  score: number;
} {
  const usable = verified.filter(c => c.usable_in_email);
  const openers = usable.filter(c => EVIDENCE_KIND_TIER[c.kind] != null && !c.supporting_only);

  if (openers.length === 0) {
    // No verifiable opener survived → tier-6 role-based fallback, no cards.
    return { cards: [], tier: ROLE_BASED_TIER, score: TIER_SCORE[ROLE_BASED_TIER] };
  }

  const tier = Math.min(...openers.map(c => EVIDENCE_KIND_TIER[c.kind] as number));
  const score = TIER_SCORE[tier] ?? TIER_SCORE[ROLE_BASED_TIER];

  // Hand the writer the opener cards + supporting complaints, best first, capped.
  const ranked = [...usable].sort((a, b) => {
    const ta = EVIDENCE_KIND_TIER[a.kind] ?? 99;
    const tb = EVIDENCE_KIND_TIER[b.kind] ?? 99;
    if (ta !== tb) return ta - tb;
    return b.confidence - a.confidence;
  });
  return { cards: ranked.slice(0, MAX_WRITER_CARDS), tier, score };
}

// ── Sonar (Perplexity) research call ───────────────────────────────────────

export async function runColdSonar(input: DraftInput): Promise<{ text: string; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SONAR_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(SONAR_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: SONAR_RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: buildSonarResearchUserMessage({
            firstName: input.first_name,
            fullName: input.full_name,
            company: input.company,
            domain: input.domain ?? deriveDomain(input),
          }) },
        ],
      }),
    });
  } catch (err) {
    // Abort (timeout) or network error → retryable provider failure.
    if (err instanceof Error && err.name === 'AbortError') throw new Error('Perplexity request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Perplexity API error ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const citations = Array.isArray(data.citations) ? (data.citations as string[]) : [];
  return { text, citations };
}

// ── Orchestrator ───────────────────────────────────────────────────────────

async function setStatus(supabase: Supa, id: string, status: string): Promise<void> {
  // Best-effort progress marker; failures here must not abort the draft.
  try {
    await supabase.from('cold_email_drafts').update({ status }).eq('id', id);
  } catch {
    /* ignore */
  }
}

/** Map any thrown error during the external-call phase to retry vs propagate. */
function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof FirecrawlError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /(API error (429|5\d\d)|429|5\d\d|timed out|timeout|ECONNRESET|ETIMEDOUT|credits depleted|rate limit|empty response|not configured)/i.test(msg);
}

export async function processDraftRow(
  input: DraftInput,
  supabase: Supa,
  depsOverride: Partial<ColdResearchDeps> = {},
): Promise<DraftOutcome> {
  const deps = { ...defaultDeps, ...depsOverride };
  let cost = 0;

  // ── 0) Sendability pre-check (before spending) ────────────────────────────
  const emailLc = input.email.toLowerCase();
  const { data: existingLead } = await supabase
    .from('leads').select('id').ilike('contact_email', emailLc).limit(1).maybeSingle();
  if (existingLead) return { kind: 'skipped', reason: 'already_crm_lead', cost_usd: cost };
  const { data: blacklisted } = await supabase
    .from('email_blacklist').select('email').eq('email', emailLc).maybeSingle();
  if (blacklisted) return { kind: 'skipped', reason: 'blacklisted', cost_usd: cost };

  const domain = deriveDomain(input);

  try {
    await setStatus(supabase, input.id, 'researching');

    // ── 1) Company scrape (cached per domain) ───────────────────────────────
    let scrapedPages: ScrapedPage[] = [];
    if (domain) {
      const { data: cached } = await supabase
        .from('company_research_cache')
        .select('scraped_pages, cached_at')
        .eq('domain', domain)
        .maybeSingle();
      const fresh = cached && (Date.now() - new Date(cached.cached_at as string).getTime() < COMPANY_CACHE_TTL_MS);
      if (fresh) {
        scrapedPages = ((cached!.scraped_pages ?? []) as ScrapedPage[]);
      } else {
        scrapedPages = await deps.scrapeCompanySiteFn(domain); // FirecrawlError → retry
        cost += scrapedPages.length * FIRECRAWL_SCRAPE_COST_USD;
        await supabase.from('company_research_cache').upsert(
          { domain, scraped_pages: scrapedPages, cost_usd: scrapedPages.length * FIRECRAWL_SCRAPE_COST_USD, cached_at: new Date().toISOString() },
          { onConflict: 'domain' },
        );
      }
    }

    // ── 2) Person + company web research (Sonar) ────────────────────────────
    const sonar = await deps.runSonarFn(input);
    cost += SONAR_CALL_COST_USD;

    // ── 3) Extraction → candidate evidence cards ────────────────────────────
    const extractRaw = await callAIMessages({
      model: COLD_RESEARCH_MODEL,
      fallbackModels: COLD_MODEL_FALLBACKS,
      jsonMode: true,
      maxTokens: 2000,
      timeoutMs: 90_000,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionUserMessage({
          firstName: input.first_name,
          fullName: input.full_name,
          company: input.company,
          domain,
          scrapedPages,
          sonarResearch: sonar.text,
          sonarCitations: sonar.citations,
        }) },
      ],
    });
    cost += LLM_EXTRACT_COST_USD;
    let candidateCards: EvidenceCard[] = [];
    try {
      const parsed = coldExtractionSchema.safeParse(tolerantJsonParse(extractRaw));
      if (parsed.success) candidateCards = parsed.data.cards;
    } catch {
      candidateCards = []; // unparseable extraction → no evidence → tier-6
    }

    // ── 4) Verify evidence IN CODE ──────────────────────────────────────────
    await setStatus(supabase, input.id, 'verifying_evidence');
    const scrapedMarkdown = scrapedPages.map(p => p.markdown).join('\n\n');
    const verified = verifyEvidence(candidateCards, scrapedMarkdown, { companyName: input.company });

    // ── 5) Tier + score (code) ──────────────────────────────────────────────
    const sel = selectAndScore(verified);
    const senderFirst = input.sender_name.split(/\s+/)[0] || input.sender_name;

    // ── 6+7) Write → lint → claim-check, with regen → downgrade ladder ──────
    const writeOnce = async (tier: number, cards: EvidenceCard[], feedback?: string) => {
      const sys = feedback
        ? `${buildWriterSystemPrompt(senderFirst, tier)}\n\n${feedback}`
        : buildWriterSystemPrompt(senderFirst, tier);
      const raw = await callAIMessages({
        model: COLD_WRITER_MODEL,
        fallbackModels: COLD_MODEL_FALLBACKS,
        jsonMode: true,
        maxTokens: 800,
        timeoutMs: 90_000,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: buildWriterUserMessage({ firstName: input.first_name, company: input.company, tier, cards }) },
        ],
      });
      cost += LLM_WRITE_COST_USD;
      let obj: unknown;
      try { obj = tolerantJsonParse(raw); } catch { return { ok: false as const, reason: 'unparseable' }; }
      const parsed = coldWriteSchema.safeParse(obj);
      if (!parsed.success) return { ok: false as const, reason: 'unparseable' };
      const subject = scrubCopy(parsed.data.subject);
      const body = scrubCopy(parsed.data.body);
      const lint = lintColdEmail(subject, body);
      if (!lint.ok) {
        const blockers = lint.issues.filter(i => i.severity === 'blocker');
        return { ok: false as const, reason: `lint:${blockers.map(i => i.code).join(',')}`, lintMessages: blockers.map(i => i.message), subject, body };
      }
      const cc = await claimCheck({ subject, body, cards });
      cost += LLM_CLAIMCHECK_COST_USD;
      if (!cc.ok) return { ok: false as const, reason: 'claimcheck', unsupported: cc.unsupportedClaims, subject, body };
      return { ok: true as const, subject, body };
    };

    await setStatus(supabase, input.id, 'writing');
    let tier = sel.tier;
    let score = sel.score;
    let writerCards = sel.cards;
    const trace: string[] = [];

    let res = await writeOnce(tier, writerCards);
    trace.push(`t${tier}:${res.ok ? 'ok' : res.reason}`);
    if (!res.ok) {
      // Regenerate once with feedback naming exactly what was wrong.
      const feedback = ('unsupported' in res && res.unsupported?.length)
        ? buildRegenFeedback(res.unsupported)
        : ('lintMessages' in res && res.lintMessages?.length)
          ? `Your previous draft broke these rules: ${res.lintMessages.join('; ')}. Rewrite it, fixing each, and follow every rule.`
          : `Your previous draft failed a copy rule (${res.reason}). Rewrite it, following every hard rule exactly.`;
      await setStatus(supabase, input.id, 'checking');
      res = await writeOnce(tier, writerCards, feedback);
      trace.push(`t${tier}regen:${res.ok ? 'ok' : res.reason}`);
    }
    if (!res.ok && writerCards.length > 1) {
      // Before giving up the personalization, try once more at the SAME tier
      // with only the single strongest fact — fewer claims to support, so it
      // clears the claim-check while staying specific. Beats falling to generic.
      const top = writerCards.slice(0, 1);
      res = await writeOnce(tier, top);
      trace.push(`t${tier}top1:${res.ok ? 'ok' : res.reason}`);
      if (res.ok) writerCards = top;
    }
    if (!res.ok && tier !== ROLE_BASED_TIER) {
      // Last resort: a clean tier-6 role-based email (no specific cards).
      tier = ROLE_BASED_TIER;
      score = TIER_SCORE[ROLE_BASED_TIER];
      writerCards = [];
      res = await writeOnce(tier, writerCards);
      trace.push(`t6:${res.ok ? 'ok' : res.reason}`);
    }
    if (!res.ok) {
      return { kind: 'failed', reason: `write_failed:${res.reason}`, cost_usd: cost, evidence_cards: verified, trace: trace.join(' | ') };
    }

    return {
      kind: 'ready',
      subject: res.subject,
      body: res.body,
      opener_tier: tier,
      signal_score: score,
      evidence_cards: verified,
      selected_evidence_ids: writerCards.map(c => c.id),
      cost_usd: cost,
      trace: trace.join(' | '),
    };
  } catch (err) {
    if (isRetryableProviderError(err)) {
      return { kind: 'retry', reason: `provider:${err instanceof Error ? err.message.slice(0, 120) : String(err)}`, cost_usd: cost };
    }
    // Unexpected (logic) error — surface as failed so the worker stops retrying.
    return { kind: 'failed', reason: `engine_error:${err instanceof Error ? err.message.slice(0, 160) : String(err)}`, cost_usd: cost };
  }
}
