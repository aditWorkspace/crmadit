# Insights Chat: Filter Bucket + Reliability Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `filter` bucket to the insights chat router for "for the last N calls, which match X?" questions, executed as hybrid (stuffed-prompt for small/factual, parallel fan-out for larger/semantic). Fix the in-production "Empty response from OpenRouter" failure caused by invalid `deepseek/deepseek-v4-pro` model slugs.

**Architecture:** Extend the existing `src/lib/ai/chat/` pipeline. Router now emits one of `lookup | filter | scope | clarify`. Orchestrator branches on the new `filter` and `clarify` kinds. New `filter.ts` executor decomposes into pure helpers (mode decision, N-clamp, concurrency, render) plus an orchestrator that pulls transcripts and runs the AI calls.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest (already configured — `npm run test` runs `vitest run`), Supabase admin client, OpenRouter via existing `callAI` / `callAIMessages` wrappers.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/constants.ts` | Modify | Replace dead `deepseek-v4-pro` slugs with valid DeepSeek IDs. |
| `src/lib/ai/openrouter.ts` | Modify | Make empty-content errors retryable across fallback models; include model slug in error messages. |
| `src/lib/ai/chat/types.ts` | Modify | Extend `RouterOutput` with `filter` and `clarify` kinds; add `FilterSpec`. |
| `src/lib/ai/chat/router.ts` | Modify | Update prompt to emit 4 buckets; parse `filter` and `clarify` payloads. |
| `src/lib/ai/chat/lookup.ts` | Modify | Swap dead fallback slugs. |
| `src/lib/ai/chat/advocate.ts` | Modify | Swap dead fallback slugs. |
| `src/lib/ai/chat/judge.ts` | Modify | Swap dead fallback slugs. |
| `src/lib/ai/chat/filter.ts` | Create | Filter executor + pure helpers (mode decision, clamp, concurrency, render). |
| `src/lib/ai/chat/orchestrator.ts` | Modify | Branch on new `filter` and `clarify` kinds before existing lookup/scope. |
| `src/lib/ai/__tests__/openrouter.test.ts` | Create | Empty-content retry behavior. |
| `src/lib/ai/chat/__tests__/router.test.ts` | Create | Router golden set across 4 buckets. |
| `src/lib/ai/chat/__tests__/filter.test.ts` | Create | Pure-helper tests (mode, clamp, render, concurrency). |

No DB migrations, no new HTTP routes, no UI changes.

---

## Task 1: Fix dead DeepSeek model slugs

**Files:**
- Modify: `src/lib/constants.ts`
- Modify: `src/lib/ai/chat/lookup.ts`
- Modify: `src/lib/ai/chat/advocate.ts`
- Modify: `src/lib/ai/chat/judge.ts`

This is a config-only change — no tests. Production was returning empty content because `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` are not valid OpenRouter routes. The chat will silently come back to life after deploy.

- [ ] **Step 1: Update constants.ts**

In `src/lib/constants.ts`, replace lines 56-66 (the "Insights-chat debate pipeline" block) with:

```ts
// Insights-chat debate pipeline. Founder explicitly asked for DeepSeek
// everywhere — no Anthropic models. v3-0324 (chat) is the workhorse;
// r1 is the reasoning-tuned model used at the judge step.
//   - CHAT_ROUTER_MODEL   DeepSeek v3. Classifies bucket + emits FTS terms.
//   - LOOKUP_MODEL        DeepSeek v3. Single-call path for factual questions
//                          and per-transcript filter classifier.
//   - ADVOCATE_MODEL      DeepSeek v3. FOR/AGAINST advocates in scope debates.
//   - JUDGE_MODEL         DeepSeek r1. Reasoning model for the deliberation.
export const CHAT_ROUTER_MODEL = DECIDER_MODEL;
export const LOOKUP_MODEL = 'deepseek/deepseek-chat-v3-0324';
export const ADVOCATE_MODEL = 'deepseek/deepseek-chat-v3-0324';
export const JUDGE_MODEL = 'deepseek/deepseek-r1';
```

- [ ] **Step 2: Update lookup.ts fallback list**

In `src/lib/ai/chat/lookup.ts`, change the `fallbackModels` line in `runLookup` from:

```ts
    fallbackModels: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2'],
```

to:

```ts
    fallbackModels: ['deepseek/deepseek-r1'],
```

- [ ] **Step 3: Update advocate.ts fallback list**

In `src/lib/ai/chat/advocate.ts`, change the `fallbackModels` line in `runAdvocate` from:

```ts
    fallbackModels: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2'],
```

to:

```ts
    fallbackModels: ['deepseek/deepseek-r1'],
```

- [ ] **Step 4: Update judge.ts fallback list**

In `src/lib/ai/chat/judge.ts`, change the `fallbackModels` line in `runJudge` from:

```ts
    fallbackModels: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2'],
```

to:

```ts
    fallbackModels: ['deepseek/deepseek-chat-v3-0324'],
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constants.ts src/lib/ai/chat/lookup.ts src/lib/ai/chat/advocate.ts src/lib/ai/chat/judge.ts
git commit -m "fix(chat): replace dead deepseek-v4-pro slugs with valid IDs

Production chat was returning 'Empty response from OpenRouter' because
deepseek/deepseek-v4-pro and deepseek/deepseek-v4-flash are not valid
OpenRouter routes. Switch to deepseek-chat-v3-0324 (workhorse) and
deepseek-r1 (judge) — both verified working via auto-followup."
```

---

## Task 2: Make OpenRouter empty-content retryable

**Files:**
- Create: `src/lib/ai/__tests__/openrouter.test.ts`
- Modify: `src/lib/ai/openrouter.ts`

A single-model blip should fall through to the fallback chain instead of failing the whole call. Today the loop only retries on `API error 429|5\d\d`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/__tests__/openrouter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callAIMessages } from '../openrouter';

describe('callAIMessages fallback behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(content: string | null) {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }

  function err(status: number, text = 'boom') {
    return {
      ok: false,
      status,
      text: async () => text,
    } as unknown as Response;
  }

  it('retries on empty content using the next fallback model', async () => {
    fetchMock.mockResolvedValueOnce(ok(''));
    fetchMock.mockResolvedValueOnce(ok('the real answer'));

    const out = await callAIMessages({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary/model',
      fallbackModels: ['fallback/model'],
    });

    expect(out).toBe('the real answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx using the next fallback model', async () => {
    fetchMock.mockResolvedValueOnce(err(503));
    fetchMock.mockResolvedValueOnce(ok('recovered'));

    const out = await callAIMessages({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary/model',
      fallbackModels: ['fallback/model'],
    });

    expect(out).toBe('recovered');
  });

  it('does NOT retry on 4xx (bad model id should fail fast)', async () => {
    fetchMock.mockResolvedValueOnce(err(400, 'bad model'));

    await expect(
      callAIMessages({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'primary/model',
        fallbackModels: ['fallback/model'],
      }),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes the failing model slug in the error message', async () => {
    fetchMock.mockResolvedValue(ok(''));

    await expect(
      callAIMessages({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'primary/model',
        fallbackModels: [],
      }),
    ).rejects.toThrow(/primary\/model/);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `npx vitest run src/lib/ai/__tests__/openrouter.test.ts`
Expected: Tests 1 and 4 FAIL (current code throws on empty content without retry; current error message does not include the model slug).

- [ ] **Step 3: Update openrouter.ts**

In `src/lib/ai/openrouter.ts`, modify the retry predicate and the error message in `singleAttempt`. Two specific edits:

**Edit A** — in `callAIMessages`, change line 58 from:

```ts
      const retryable = /API error (429|5\d\d)/.test(message);
```

to:

```ts
      const retryable =
        /API error (429|5\d\d)/.test(message) ||
        /empty response/i.test(message);
```

**Edit B** — in `singleAttempt`, change the empty-response throw (line 95) from:

```ts
    if (!content) throw new Error('Empty response from OpenRouter');
```

to:

```ts
    if (!content) {
      throw new Error(
        `Empty response from OpenRouter (model=${params.model || DEFAULT_MODEL})`,
      );
    }
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx vitest run src/lib/ai/__tests__/openrouter.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/__tests__/openrouter.test.ts src/lib/ai/openrouter.ts
git commit -m "fix(openrouter): make empty-content retryable across fallback models

A single provider returning 200 with empty content (typical for an
unrouteable model id on openrouter) used to abort the whole call.
Now it falls through to the next fallback model. Error message also
includes the failing model slug so future failures are diagnosable
without grepping."
```

---

## Task 3: Extend chat types

**Files:**
- Modify: `src/lib/ai/chat/types.ts`

Adds `FilterSpec` and broadens `RouterOutput` to a discriminated union over `lookup | filter | scope | clarify`. No tests — type-only change, verified by tsc.

- [ ] **Step 1: Replace types.ts router exports**

In `src/lib/ai/chat/types.ts`, replace lines 31-36 (the `QuestionKind` and `RouterOutput` block):

```ts
export type QuestionKind = 'lookup' | 'scope';

export interface RouterOutput {
  kind: QuestionKind;
  search_terms: string[];
}
```

with:

```ts
export type QuestionKind = 'lookup' | 'filter' | 'scope' | 'clarify';

export interface FilterSpec {
  // null means "user did not specify N"; the executor defaults to 20.
  n: number | null;
  // v1 only supports recency-ordered selection. Schema kept open for
  // future ordering modes (e.g. 'all', 'this_week') without breaking changes.
  ordering: 'recent';
  // Natural-language criterion as the founder phrased it. The classifier
  // tests each transcript against this string verbatim.
  criterion: string;
  criterion_type: 'factual' | 'semantic';
}

export type RouterOutput =
  | { kind: 'lookup'; search_terms: string[] }
  | { kind: 'scope'; search_terms: string[] }
  | { kind: 'filter'; search_terms: string[]; filter: FilterSpec }
  | { kind: 'clarify'; clarify_question: string };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in `router.ts` and `orchestrator.ts` (they construct/consume the old shape). These get fixed in Tasks 4 and 7. Note them and continue.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/chat/types.ts
git commit -m "feat(chat): extend RouterOutput to 4 buckets (lookup/filter/scope/clarify)

Adds FilterSpec for per-call iteration questions. Discriminated union
keeps the type narrow per bucket — clarify carries clarify_question,
filter carries the FilterSpec, lookup/scope keep their search_terms.
Compile errors in router.ts/orchestrator.ts are addressed in
follow-up tasks."
```

---

## Task 4: Update router with 4-bucket prompt + tests

**Files:**
- Modify: `src/lib/ai/chat/router.ts`
- Create: `src/lib/ai/chat/__tests__/router.test.ts`

- [ ] **Step 1: Write golden-set tests**

Create `src/lib/ai/chat/__tests__/router.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/openrouter', () => ({
  callAI: vi.fn(),
}));

import { callAI } from '@/lib/ai/openrouter';
import { classifyQuestion } from '../router';

const mockedCallAI = vi.mocked(callAI);

describe('classifyQuestion', () => {
  beforeEach(() => {
    mockedCallAI.mockReset();
  });

  it('parses a filter question with explicit N and semantic criterion', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'filter',
        search_terms: ['privacy', 'security', 'data'],
        filter: {
          n: 20,
          ordering: 'recent',
          criterion: 'worried about privacy and wants a security sheet',
          criterion_type: 'semantic',
        },
      }),
    );

    const out = await classifyQuestion(
      'for the last 20 calls, which were worried about privacy?',
    );

    expect(out.kind).toBe('filter');
    if (out.kind !== 'filter') throw new Error('narrowing');
    expect(out.filter.n).toBe(20);
    expect(out.filter.criterion_type).toBe('semantic');
  });

  it('parses a lookup question (no per-call iteration)', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'lookup',
        search_terms: ['Ramp', 'onboarding', 'Alex'],
      }),
    );

    const out = await classifyQuestion(
      'what did Alex at Ramp say about onboarding?',
    );

    expect(out.kind).toBe('lookup');
    if (out.kind === 'lookup') expect(out.search_terms).toContain('Ramp');
  });

  it('parses a scope question', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'scope',
        search_terms: ['Slack', 'integration'],
      }),
    );

    const out = await classifyQuestion(
      'should we cut Slack support from scope?',
    );

    expect(out.kind).toBe('scope');
  });

  it('parses a clarify response', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'clarify',
        clarify_question: 'Do you mean active users or all leads?',
      }),
    );

    const out = await classifyQuestion('which ones are doing well?');

    expect(out.kind).toBe('clarify');
    if (out.kind === 'clarify') {
      expect(out.clarify_question).toMatch(/active users/);
    }
  });

  it('falls back to scope on malformed JSON', async () => {
    mockedCallAI.mockResolvedValue('not json at all {{{');

    const out = await classifyQuestion('something ambiguous');

    expect(out.kind).toBe('scope');
  });

  it('coerces invalid filter payload to lookup (defensive)', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'filter',
        search_terms: ['x'],
        // missing filter field — bad model output
      }),
    );

    const out = await classifyQuestion('for last 20, which X');
    // Spec: "Router emits kind='filter' but no filter field → treat as lookup."
    expect(out.kind).toBe('lookup');
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

Run: `npx vitest run src/lib/ai/chat/__tests__/router.test.ts`
Expected: All 6 tests FAIL — current router only knows `lookup | scope`.

- [ ] **Step 3: Replace router.ts**

Replace the entire contents of `src/lib/ai/chat/router.ts` with:

```ts
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
    maxTokens: 400,
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
```

- [ ] **Step 4: Run the tests — confirm they pass**

Run: `npx vitest run src/lib/ai/chat/__tests__/router.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: One remaining error in `orchestrator.ts` referring to `routed.kind`. Fixed in Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/chat/router.ts src/lib/ai/chat/__tests__/router.test.ts
git commit -m "feat(chat): router emits 4 buckets — lookup/filter/scope/clarify

filter is for per-call iteration questions ('for the last 20 calls,
which X'). criterion_type=factual|semantic drives executor mode.
clarify lets the router push back when the question is too ambiguous
to answer without disambiguation. Defensive fallback: malformed filter
payload coerces to lookup."
```

---

## Task 5: Filter executor — pure helpers

**Files:**
- Create: `src/lib/ai/chat/filter.ts`
- Create: `src/lib/ai/chat/__tests__/filter.test.ts`

We're decomposing the executor into four testable pure functions plus an orchestrator that wires them. This task ships the pure helpers under TDD; Task 6 wires them into the executor.

- [ ] **Step 1: Write tests for the pure helpers**

Create `src/lib/ai/chat/__tests__/filter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  clampN,
  decideFilterMode,
  renderFilterMarkdown,
  runWithConcurrency,
} from '../filter';

describe('clampN', () => {
  it('defaults null to 20', () => {
    expect(clampN(null)).toBe(20);
  });
  it('clamps above 50', () => {
    expect(clampN(1000)).toBe(50);
  });
  it('clamps below 1', () => {
    expect(clampN(0)).toBe(1);
    expect(clampN(-5)).toBe(1);
  });
  it('passes through valid N', () => {
    expect(clampN(15)).toBe(15);
  });
});

describe('decideFilterMode', () => {
  it('stuffed for factual + small N', () => {
    expect(decideFilterMode({ criterion_type: 'factual', n: 5 })).toBe('stuffed');
    expect(decideFilterMode({ criterion_type: 'factual', n: 10 })).toBe('stuffed');
  });
  it('fan-out for factual + large N', () => {
    expect(decideFilterMode({ criterion_type: 'factual', n: 11 })).toBe('fan-out');
  });
  it('fan-out for semantic regardless of N', () => {
    expect(decideFilterMode({ criterion_type: 'semantic', n: 1 })).toBe('fan-out');
    expect(decideFilterMode({ criterion_type: 'semantic', n: 50 })).toBe('fan-out');
  });
});

describe('renderFilterMarkdown', () => {
  it('renders matches', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'worried about privacy',
      matches: [
        { company: 'Ramp', contact: 'Alex', date: '2026-04-12', evidence: 'asked about SOC2' },
        { company: 'Linear', contact: 'Sara', date: '2026-04-15', evidence: 'wants data sheet' },
      ],
      failures: 0,
    });
    expect(out).toContain('Checked 20');
    expect(out).toContain('2 matched');
    expect(out).toContain('Ramp');
    expect(out).toContain('asked about SOC2');
  });

  it('renders zero matches with the criterion echoed', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'mentioned Linear',
      matches: [],
      failures: 0,
    });
    expect(out).toMatch(/None matched/i);
    expect(out).toContain('mentioned Linear');
  });

  it('appends a footer when some calls failed', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'X',
      matches: [{ company: 'A', contact: 'B', date: '2026-04-01', evidence: 'e' }],
      failures: 3,
    });
    expect(out).toMatch(/3 transcripts could not be evaluated/);
  });
});

describe('runWithConcurrency', () => {
  it('limits in-flight calls to the cap', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    const results = await runWithConcurrency(items, 4, async (i) => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return i * 2;
    });

    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(maxSeen).toBeLessThanOrEqual(4);
  });

  it('captures failures via Promise.allSettled semantics', async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (i) => {
      if (i === 2) throw new Error('boom');
      return i * 10;
    });

    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: false, error: expect.any(Error) });
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

Run: `npx vitest run src/lib/ai/chat/__tests__/filter.test.ts`
Expected: All tests FAIL — file doesn't exist yet.

- [ ] **Step 3: Create filter.ts with the pure helpers**

Create `src/lib/ai/chat/filter.ts`:

```ts
import type { FilterSpec } from './types';

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
  company: string;
  contact: string;
  date: string;     // YYYY-MM-DD
  evidence: string;
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
```

- [ ] **Step 4: Run the tests — confirm they pass**

Run: `npx vitest run src/lib/ai/chat/__tests__/filter.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/chat/filter.ts src/lib/ai/chat/__tests__/filter.test.ts
git commit -m "feat(chat): filter executor pure helpers

clampN (default 20, max 50), decideFilterMode (stuffed for factual+N<=10,
fan-out otherwise), renderFilterMarkdown, runWithConcurrency. All four
are pure and unit-tested. Wiring into the executor + DB query lands in
the next task."
```

---

## Task 6: Filter executor — orchestration

**Files:**
- Modify: `src/lib/ai/chat/filter.ts`

This task wires the pure helpers into `runFilter`, which pulls transcripts from Supabase and dispatches AI calls. We don't unit-test the orchestrator directly — the helpers are tested, and the integration gets a manual smoke at the end. (Per project memory: don't repeat happy-path hits on routes that call AI; stick to the 401 matrix and unit tests for the small pure pieces.)

- [ ] **Step 1: Append `runFilter` to filter.ts**

Append to `src/lib/ai/chat/filter.ts` (do NOT delete the existing exports from Task 5):

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { callAIMessages } from '@/lib/ai/openrouter';
import { LOOKUP_MODEL } from '@/lib/constants';

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
    matches.push({ company, contact, date, evidence: m.evidence });
  }

  return renderFilterMarkdown({
    checked: transcripts.length,
    criterion: filter.criterion,
    matches,
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
      matches.push({ company, contact, date, evidence: r.value.evidence });
    }
  }

  if (failures === transcripts.length) {
    return `**Filter failed for all ${transcripts.length} transcripts.** Try again — this is usually a model provider blip.`;
  }

  return renderFilterMarkdown({
    checked: transcripts.length,
    criterion: filter.criterion,
    matches,
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
```

- [ ] **Step 2: Re-run the helper tests**

Run: `npx vitest run src/lib/ai/chat/__tests__/filter.test.ts`
Expected: All helper tests still PASS (no regression from the appended code).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: One remaining error in `orchestrator.ts`. Fixed in Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/chat/filter.ts
git commit -m "feat(chat): runFilter orchestrator — stuffed + fan-out modes

Pulls last N transcripts ordered by created_at DESC. Stuffed mode (1
AI call) for factual N<=10; fan-out (per-transcript classifier with
concurrency cap=8) otherwise. Fan-out reads the tail 6000 chars of
raw_text where objections cluster. Promise.allSettled-style behavior:
individual classifier failures drop out of results, full-batch failure
returns a clear retry message."
```

---

## Task 7: Orchestrator wiring

**Files:**
- Modify: `src/lib/ai/chat/orchestrator.ts`

- [ ] **Step 1: Replace orchestrator.ts**

Replace the entire contents of `src/lib/ai/chat/orchestrator.ts` with:

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { classifyQuestion } from './router';
import { retrieveTranscripts } from './retriever';
import { buildLeadIndex } from './lead-index';
import { formatProfileCards } from './profile-card';
import { runAdvocate } from './advocate';
import { runJudge } from './judge';
import { runLookup } from './lookup';
import { runFilter } from './filter';
import type { HistoryMessage } from './types';

interface AnswerArgs {
  question: string;
  history?: HistoryMessage[];
}

export async function answerChat({ question, history = [] }: AnswerArgs): Promise<string> {
  const trimmedHistory = history.slice(-12);

  // Classify first. Filter and clarify don't need FTS retrieval at all —
  // skip the parallel fetch when the router routes to those buckets.
  const routed = await classifyQuestion(question);

  if (routed.kind === 'clarify') {
    return `Before I answer — ${routed.clarify_question}`;
  }

  if (routed.kind === 'filter') {
    return runFilter({ filter: routed.filter });
  }

  // lookup / scope still need knowledge docs + lead index + retrieval.
  const [knowledgeDocs, leadIndex, transcripts] = await Promise.all([
    fetchKnowledgeDocs(),
    buildLeadIndex(),
    retrieveTranscripts(routed.search_terms, 8),
  ]);
  const retrievedCards = formatProfileCards(transcripts);

  if (routed.kind === 'lookup') {
    return runLookup({
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    });
  }

  // routed.kind === 'scope'
  const [forArg, againstArg] = await Promise.all([
    runAdvocate({
      side: 'for',
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    }),
    runAdvocate({
      side: 'against',
      question,
      history: trimmedHistory,
      retrievedCards,
      leadIndex,
      knowledgeDocs,
    }),
  ]);

  return runJudge({
    question,
    history: trimmedHistory,
    advocates: [forArg, againstArg],
    leadIndex,
    retrievedCards,
  });
}

async function fetchKnowledgeDocs(): Promise<string> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content')
    .order('doc_type');
  if (!data?.length) return '(no knowledge docs on file)';
  return data
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm run test`
Expected: All tests PASS, including the new openrouter, router, and filter test files.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/chat/orchestrator.ts
git commit -m "feat(chat): wire filter and clarify branches into orchestrator

clarify returns the router's clarify_question verbatim — no AI call.
filter calls runFilter and skips the FTS retriever entirely (filter
selects by recency, not relevance). lookup and scope paths unchanged."
```

---

## Task 8: Manual smoke + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm run test`
Expected: All PASS, no skipped tests in the new files.

- [ ] **Step 2: Local manual smoke**

Start dev server: `npm run dev` (in another terminal).

In the running app, open the insights chat and send the original failing question:

> for the last 20 calls, which had people worried about privacy and want me to send them a data security sheet?

Expected: A response within ~10 seconds, formatted as `**Checked N calls — M matched.**` followed by bulleted matches, OR `**Checked N calls. None matched the criterion: ...**` if nothing matches in current data. **No** "Empty response from OpenRouter" error.

Also smoke a lookup question (e.g. "what did Linear say about onboarding") — should still take the existing lookup path.

If the smoke fails, do NOT commit a "fix" without a regression test. Capture the actual response, debug the root cause, add a test that would have caught it.

- [ ] **Step 3: Push the branch**

```bash
git push origin feature/automated-outreach
```

(Or whatever the current branch is. Verify with `git rev-parse --abbrev-ref HEAD` first.)

- [ ] **Step 4: Done**

The original failure (`Empty response from OpenRouter`) is fixed by Task 1 alone. Tasks 2-7 add the new filter bucket. If you need to ship the fix immediately and defer the filter work, Tasks 1 and 2 are deployable on their own and do not depend on 3-7.

---

## Self-review notes (resolved during planning)

- ✅ Spec coverage: all spec sections map to tasks (model fix → T1, retry behavior → T2, types → T3, router → T4, filter executor → T5+T6, orchestrator → T7, smoke → T8). N-clamp at 50 lives in T5. Tail-truncation rationale in T6.
- ✅ No placeholders. Every step has either complete code or an exact command with expected output.
- ✅ Type consistency: `RouterOutput` is a discriminated union (T3) — every consumer in T4/T5/T6/T7 narrows on `kind` before accessing bucket-specific fields. `FilterSpec` is the single source of truth for the filter shape.
- ✅ The `clarify` bucket in T7 returns the router's text verbatim with a `"Before I answer — "` prefix; tests in T4 verify the router emits the right field. No second "clarify writer" exists, so no duplication.
