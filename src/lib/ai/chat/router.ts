import { callAI } from '@/lib/ai/openrouter';
import { CHAT_ROUTER_MODEL } from '@/lib/constants';
import type { RouterOutput, FilterSpec } from './types';

const SYSTEM_PROMPT = `You classify insight-chat questions for a founder analyzing prospect discovery calls.

Output strict JSON only. The shape depends on the bucket:

{ "kind": "lookup",   "search_terms": [...] }
{ "kind": "scope",    "search_terms": [...] }
{ "kind": "filter",   "search_terms": [...],
  "filter": { "n": <number|null>, "ordering": "recent",
              "criterion": "<rephrased criterion>",
              "criterion_type": "factual" | "semantic" } }
{ "kind": "clarify",  "clarify_question": "<one or two short clarifying questions>" }

**lookup** = factual query about a specific prospect, call, count, or recent fact. No per-call iteration.
  Examples:
    - "what did Alex at Ramp say about onboarding?"
    - "which prospects mentioned Linear?"   (no explicit count → lookup)
    - "summarize the 2026-04-12 call with Linear"

**filter** = the founder names a count or scope ("the last 20", "all 50", "every call this week") AND asks per-call ("which ones", "for each", "who said"). The system will iterate the last N transcripts and test each one.
  - Extract n from the question. "the last 20" → n=20. "all 50" → n=50. If they say "for each call" or "all my calls" with no number → n=null.
  - criterion = a one-sentence rephrasing of what to match.
  - criterion_type:
      "factual"  if the criterion is a keyword/topic mention or structural fact
                 (e.g. "mentioned Slack", "from a Series A company", "uses Linear").
      "semantic" if the criterion needs reading-between-lines
                 (e.g. "worried about privacy", "frustrated with onboarding",
                 "leaning toward yes", "wants a security sheet").
  Examples:
    - "for the last 20 calls, which were worried about privacy?"
        → filter, n=20, criterion="worried about privacy", criterion_type="semantic"
    - "across all 50 prospects, who mentioned Linear?"
        → filter, n=50, criterion="mentioned Linear", criterion_type="factual"

**scope** = asks whether to build/prioritize, whether a pattern is real, what the product should focus on. Anything requiring weighing evidence to reach a roadmap conclusion.
  Examples:
    - "do prospects actually want a Slack integration?"
    - "is onboarding friction a real pattern or just 1-2 people?"

**clarify** = the question is too ambiguous to answer well even after retrieval. Use sparingly — only when you cannot tell which bucket applies or which subset of leads/timeframe the user means. Output one or two short clarifying questions.
  Examples:
    - "which ones are doing well?"  (which ones — all leads? active users? this week?)

When in doubt between scope and lookup, pick scope. When in doubt between filter and lookup, pick lookup (filter is more expensive).

**search_terms** (lookup/filter/scope only): 3–5 keywords or short phrases for Postgres FTS. Plain noun phrases, no stopwords. Expand with close synonyms ("Slack" → also "messaging", "notifications").`;

export async function classifyQuestion(question: string): Promise<RouterOutput> {
  const raw = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `Question: ${question}`,
    model: CHAT_ROUTER_MODEL,
    jsonMode: true,
    // Router emits a small JSON object (kind + 3-5 search terms). 200 is
    // ample and conserves OpenRouter credits — the original 400 burned
    // budget and tripped a 402 when credits got tight.
    maxTokens: 200,
  });

  try {
    const parsed = JSON.parse(raw);
    return parseRouterOutput(parsed, question);
  } catch {
    return {
      kind: 'scope',
      search_terms: fallbackSearchTerms(question),
    };
  }
}

function parseRouterOutput(parsed: unknown, question: string): RouterOutput {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : '';

  if (kind === 'clarify' && typeof obj.clarify_question === 'string' && obj.clarify_question.trim()) {
    return { kind: 'clarify', clarify_question: obj.clarify_question.trim() };
  }

  const search_terms = Array.isArray(obj.search_terms)
    ? obj.search_terms.filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  if (kind === 'filter') {
    const filter = parseFilterSpec(obj.filter);
    if (!filter) {
      // Defensive: bad model output. Fall back to lookup with whatever
      // search terms we got. Cheaper than running a malformed filter.
      return { kind: 'lookup', search_terms: search_terms.length ? search_terms : fallbackSearchTerms(question) };
    }
    return { kind: 'filter', search_terms, filter };
  }

  if (kind === 'lookup') {
    return { kind: 'lookup', search_terms };
  }

  // Anything else (or 'scope') → scope.
  return { kind: 'scope', search_terms: search_terms.length ? search_terms : fallbackSearchTerms(question) };
}

function parseFilterSpec(raw: unknown): FilterSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const criterion = typeof obj.criterion === 'string' ? obj.criterion.trim() : '';
  if (!criterion) return null;

  const criterion_type = obj.criterion_type === 'factual' ? 'factual' : 'semantic';

  let n: number | null = null;
  if (typeof obj.n === 'number' && Number.isFinite(obj.n) && obj.n > 0) {
    n = Math.floor(obj.n);
  }

  return {
    n,
    ordering: 'recent',
    criterion,
    criterion_type,
  };
}

function fallbackSearchTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);
}
