import type { FilterSpec } from './types';
import { createAdminClient } from '@/lib/supabase/admin';
import { callAIMessages } from '@/lib/ai/openrouter';
import { LOOKUP_MODEL } from '@/lib/constants';

const DEFAULT_N = 20;
const MAX_N = 50;
const STUFFED_CUTOFF = 10;

export function clampN(n: number | null): number {
  if (n === null || n === undefined) return DEFAULT_N;
  if (!Number.isFinite(n)) return DEFAULT_N;
  if (n < 1) return 1;
  if (n > MAX_N) return MAX_N;
  return Math.floor(n);
}

export type FilterMode = 'stuffed' | 'fan-out';

export function decideFilterMode(args: {
  criterion_type: FilterSpec['criterion_type'];
  n: number;
}): FilterMode {
  if (args.criterion_type === 'factual' && args.n <= STUFFED_CUTOFF) return 'stuffed';
  return 'fan-out';
}

export interface FilterMatch {
  // Used to dedupe when one lead has multiple matching transcripts.
  // null for advisor / misc transcripts that have no lead — those never
  // collapse against each other.
  lead_id: string | null;
  company: string;
  contact: string;
  date: string;     // YYYY-MM-DD
  evidence: string;
}

// Collapse repeated matches for the same lead. Input order wins (callers
// pass matches in created_at DESC order, so the most recent transcript
// is the one we keep). Null lead_ids are passed through untouched.
export function dedupeMatchesByLead(matches: FilterMatch[]): FilterMatch[] {
  const seen = new Set<string>();
  const out: FilterMatch[] = [];
  for (const m of matches) {
    if (m.lead_id) {
      if (seen.has(m.lead_id)) continue;
      seen.add(m.lead_id);
    }
    out.push(m);
  }
  return out;
}

export function renderFilterMarkdown(args: {
  checked: number;
  criterion: string;
  matches: FilterMatch[];
  failures: number;
}): string {
  const { checked, criterion, matches, failures } = args;
  const parts: string[] = [];

  if (matches.length === 0) {
    parts.push(
      `**Checked ${checked} call${checked === 1 ? '' : 's'}. None matched the criterion: "${criterion}".**`,
    );
  } else {
    parts.push(
      `**Checked ${checked} call${checked === 1 ? '' : 's'} — ${matches.length} matched.**`,
    );
    parts.push('');
    for (const m of matches) {
      parts.push(`- **${m.company}** (${m.contact}, ${m.date}) — "${m.evidence}"`);
    }
    parts.push('');
    parts.push(
      `_Want me to draft a follow-up for ${matches.length === 1 ? 'this prospect' : 'these prospects'}? Reply with names or "all"._`,
    );
  }

  if (failures > 0) {
    parts.push('');
    parts.push(
      `_(${failures} transcript${failures === 1 ? '' : 's'} could not be evaluated this run.)_`,
    );
  }

  return parts.join('\n');
}

// Settled-result shape so callers can distinguish failures without try/catch
// per item.
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

// Bounded-concurrency map. Preserves input order in the result array. Each
// task is awaited; failures become { ok: false } entries instead of throwing.
export async function runWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<Settled<O>[]> {
  const results: Settled<O>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { ok: true, value };
      } catch (err) {
        results[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---- Executor -----------------------------------------------------------

const FANOUT_CONCURRENCY = 8;
const FANOUT_RAW_TEXT_TAIL_CHARS = 6000;
const STUFFED_TIMEOUT_MS = 60_000;
const FANOUT_PER_CALL_TIMEOUT_MS = 30_000;

interface RunFilterArgs {
  filter: FilterSpec;
}

export async function runFilter(args: RunFilterArgs): Promise<string> {
  const { filter } = args;
  const n = clampN(filter.n);
  const mode = decideFilterMode({ criterion_type: filter.criterion_type, n });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('transcripts')
    .select(`
      id, lead_id, created_at, raw_text,
      ai_summary, ai_pain_points, ai_product_feedback, ai_key_quotes,
      participant_name,
      leads(contact_name, company_name)
    `)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false })
    .limit(n);

  if (error) throw new Error(`Filter DB query failed: ${error.message}`);
  const transcripts = (data || []) as unknown as TranscriptForFilter[];

  if (transcripts.length === 0) {
    return `**No completed transcripts on file.** Cannot evaluate criterion: "${filter.criterion}".`;
  }

  if (mode === 'stuffed') {
    return runStuffed(transcripts, filter);
  }
  return runFanOut(transcripts, filter);
}

interface TranscriptForFilter {
  id: string;
  lead_id: string | null;
  created_at: string;
  raw_text: string | null;
  ai_summary: string | null;
  ai_pain_points: unknown;
  ai_product_feedback: unknown;
  ai_key_quotes: unknown;
  participant_name: string | null;
  leads: { contact_name: string | null; company_name: string | null } | null;
}

function transcriptLabel(t: TranscriptForFilter): { company: string; contact: string; date: string } {
  const company = t.leads?.company_name ?? '(no company)';
  const contact = t.leads?.contact_name ?? t.participant_name ?? '(unknown)';
  const date = (t.created_at || '').slice(0, 10);
  return { company, contact, date };
}

// ---- Stuffed mode -------------------------------------------------------

async function runStuffed(
  transcripts: TranscriptForFilter[],
  filter: FilterSpec,
): Promise<string> {
  const cards = transcripts.map((t, i) => {
    const { company, contact, date } = transcriptLabel(t);
    const summary = t.ai_summary || '(no summary)';
    const quotes = JSON.stringify(t.ai_key_quotes ?? []);
    const pains = JSON.stringify(t.ai_pain_points ?? []);
    const feedback = JSON.stringify(t.ai_product_feedback ?? []);
    return `### Transcript ${i + 1}: ${company} · ${contact} · ${date} · id=${t.id}
Summary: ${summary}
Key quotes: ${quotes}
Pain points: ${pains}
Product feedback: ${feedback}`;
  }).join('\n\n');

  const systemPrompt = `You evaluate a fixed list of transcripts against a single criterion.

Output strict JSON only:
{ "matches": [ { "id": "<transcript id>", "evidence": "<short quote or paraphrase from THIS transcript>" } ] }

Rules:
- Include only transcripts that genuinely match the criterion. Be conservative.
- "evidence" must be specific to that transcript — quote when possible, paraphrase only if no exact quote applies.
- If nothing matches, return { "matches": [] }.`;

  const userMessage = `Criterion: ${filter.criterion}

Transcripts:

${cards}`;

  const raw = await callAIMessages({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    model: LOOKUP_MODEL,
    jsonMode: true,
    maxTokens: 1500,
    timeoutMs: STUFFED_TIMEOUT_MS,
    fallbackModels: ['deepseek/deepseek-r1'],
  });

  let parsed: { matches?: { id?: string; evidence?: string }[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return renderFilterMarkdown({
      checked: transcripts.length,
      criterion: filter.criterion,
      matches: [],
      failures: transcripts.length,
    });
  }

  const byId = new Map(transcripts.map(t => [t.id, t]));
  const matches: FilterMatch[] = [];
  for (const m of parsed.matches ?? []) {
    if (!m?.id || !m?.evidence) continue;
    const t = byId.get(m.id);
    if (!t) continue;
    const { company, contact, date } = transcriptLabel(t);
    matches.push({ lead_id: t.lead_id, company, contact, date, evidence: m.evidence });
  }

  return renderFilterMarkdown({
    checked: transcripts.length,
    criterion: filter.criterion,
    matches: dedupeMatchesByLead(matches),
    failures: 0,
  });
}

// ---- Fan-out mode -------------------------------------------------------

async function runFanOut(
  transcripts: TranscriptForFilter[],
  filter: FilterSpec,
): Promise<string> {
  const settled = await runWithConcurrency(transcripts, FANOUT_CONCURRENCY, t => classifyOne(t, filter));

  const matches: FilterMatch[] = [];
  let failures = 0;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const t = transcripts[i];
    if (!r.ok) {
      failures += 1;
      continue;
    }
    if (r.value.match && r.value.evidence) {
      const { company, contact, date } = transcriptLabel(t);
      matches.push({ lead_id: t.lead_id, company, contact, date, evidence: r.value.evidence });
    }
  }

  if (failures === transcripts.length) {
    return `**Filter failed for all ${transcripts.length} transcripts.** Try again — this is usually a model provider blip.`;
  }

  return renderFilterMarkdown({
    checked: transcripts.length,
    criterion: filter.criterion,
    matches: dedupeMatchesByLead(matches),
    failures,
  });
}

interface PerCallResult {
  match: boolean;
  evidence: string | null;
}

async function classifyOne(
  t: TranscriptForFilter,
  filter: FilterSpec,
): Promise<PerCallResult> {
  // Take the tail of raw_text — discovery-call objections, pricing concerns,
  // and "happy to chat more" signals tend to land in the back half.
  const raw = (t.raw_text || '').slice(-FANOUT_RAW_TEXT_TAIL_CHARS);
  const summary = t.ai_summary || '(no summary)';

  const systemPrompt = `You decide whether a single discovery-call transcript matches a criterion.

Output strict JSON only:
{ "match": true | false, "evidence": "<one short quote or paraphrase from this transcript>" | null }

Rules:
- Be conservative. If the transcript does not clearly support the criterion, return match=false, evidence=null.
- "evidence" must come from THIS transcript. Quote when possible.
- Do not fabricate. If the transcript is empty or off-topic, return match=false.`;

  const { company, contact, date } = transcriptLabel(t);
  const userMessage = `Criterion: ${filter.criterion}

Transcript metadata: ${company} · ${contact} · ${date}

Summary: ${summary}

Raw transcript (tail):
${raw}`;

  const responseText = await callAIMessages({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    model: LOOKUP_MODEL,
    jsonMode: true,
    maxTokens: 200,
    timeoutMs: FANOUT_PER_CALL_TIMEOUT_MS,
    fallbackModels: ['deepseek/deepseek-r1'],
  });

  const parsed = JSON.parse(responseText) as { match?: boolean; evidence?: string | null };
  return {
    match: parsed.match === true,
    evidence: parsed.match === true && typeof parsed.evidence === 'string' ? parsed.evidence : null,
  };
}
