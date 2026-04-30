# Insights Chat: Filter Bucket + Reliability Fix

**Date:** 2026-04-29
**Status:** Approved for implementation planning
**Scope:** Add a third router bucket — `filter` — to the existing `/insights` chat for "for each of the last N calls, which match criterion X?" questions. Fix the in-production "Empty response from OpenRouter" failure (root cause: invalid `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` model IDs in `src/lib/constants.ts`). Tighten the OpenRouter wrapper so empty content is retryable, not fatal.

## Problem

Two concrete failures observed today (2026-04-29):

1. **Bucket mismatch.** The router currently classifies into `lookup | scope`. A question like "for which of these calls are people worried about privacy and want me to send a security sheet" is routed to `lookup`, which retrieves the top-8 transcripts via Postgres FTS on the term "privacy". This (a) misses transcripts that discuss privacy without using the word, and (b) gives a sample, not a complete check across the calls the founder actually means ("the last 20"). The user explicitly wants per-call iteration: "set up a four-loop for the last 20 calls for each of the ones and check to see if it fits."

2. **Empty-response error in production.** The chat returned `Failed to generate answer: Empty response from OpenRouter`. Source: `openrouter.ts:95` throws when `data.choices[0].message.content` is empty. Constants point `LOOKUP_MODEL`, `ADVOCATE_MODEL`, and `JUDGE_MODEL` at `deepseek/deepseek-v4-pro` with `deepseek/deepseek-v4-flash` as the fallback. As of 2026-04-29 those slugs are not valid OpenRouter routes, and OpenRouter sometimes returns a 200 with empty `content` for an unrouteable model rather than a clean 4xx. Both fallback hops hit the same dead end, so the caller sees "Empty response."

## Goal

The founder asks "for the last 20 calls, which had X?" and gets back a structured list of matches — one bullet per matching call with the company, date, and a one-line evidence quote — in under 10 seconds. Simple lookups still take the lookup path; roadmap/opinion questions still take the debate path. The chat does not fail with empty-response errors against valid model IDs.

## Non-goals

- Streaming partial results to the chat UI as each transcript is checked.
- Action CTAs on filter results ("send security sheet to these 4 leads"). The output is read-only text. Acting on it stays manual for now.
- Restructuring lookup or scope paths. They keep their current behavior.
- Filter over the leads table or interactions table. v1 only iterates transcripts.

## Architecture

### Per-turn pipeline

```
User question
  ↓
Router (DeepSeek v3, existing slug)
  ↓ kind ∈ { lookup, filter, scope, clarify }
  ↓
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ lookup       │ filter (NEW) │ scope        │ clarify (NEW)│
│ (existing)   │              │ (existing)   │              │
│              │ runFilter    │              │ return the   │
│              │ ↓            │              │ router's     │
│              │ stuffed OR   │              │ clarify_     │
│              │ fan-out      │              │ question     │
│              │ ↓            │              │ verbatim,    │
│              │ markdown     │              │ no AI call   │
│              │ list         │              │              │
└──────────────┴──────────────┴──────────────┴──────────────┘
  ↓
Persist as assistant message → return to UI
```

### Router output schema

The existing router (`src/lib/ai/chat/router.ts`) emits `{ kind, search_terms }`. Extended schema:

```ts
type RouterOutput =
  | { kind: 'lookup' | 'scope'; search_terms: string[] }
  | { kind: 'filter'; search_terms: string[]; filter: FilterSpec }
  | { kind: 'clarify'; clarify_question: string };

type FilterSpec = {
  n: number | null;                 // parsed from question; null → default 20
  ordering: 'recent';               // v1 only supports 'recent'
  criterion: string;                // natural-language criterion to test
  criterion_type: 'factual' | 'semantic';
};
```

`criterion_type` decisions:
- `factual` — keyword/topic mention, structural fact ("mentioned Slack", "from a Series A company", "uses Linear"). Cheap to check from `ai_summary` + `ai_key_quotes`.
- `semantic` — requires reading-between-lines ("worried about privacy", "frustrated with onboarding", "leaning toward yes"). Needs raw transcript text.

The router prompt is updated with: a `filter` bucket definition, examples ("for the last 20 calls, which had X" → `filter`; "what did Linear say" → `lookup`; "should we build Slack support" → `scope`; "what do you mean by X" → `clarify`), and instructions to extract `n` from explicit numbers in the question. **Filter routing rule for the prompt: only emit `kind=filter` when the question explicitly names a count or scope ("the last 20", "all 50", "every call this week") AND asks per-call ("which ones", "for each"). Without an explicit count, prefer `lookup` so we don't fan-out unnecessarily.** If the question matches `filter` but no number is given, the router emits `n: null` and the executor defaults to 20.

### Filter executor (`src/lib/ai/chat/filter.ts`, new file)

```
runFilter({ filter, knowledgeDocs }) → string

1. Resolve N: filter.n ?? 20.
2. Pull last N transcripts: WHERE processing_status='completed'
   ORDER BY created_at DESC LIMIT N. Join lead for company/contact.
3. Mode decision:
     stuffed   if criterion_type === 'factual' && N <= 10
     fan-out   otherwise
4a. Stuffed: one call to LOOKUP_MODEL.
    Prompt input per transcript: ai_summary + ai_key_quotes + ai_pain_points
                                 + ai_product_feedback (no raw_text).
    Output: JSON { matches: [{ transcript_id, evidence }] }.
4b. Fan-out: parallel classifier calls to LOOKUP_MODEL, concurrency cap = 8.
    Per transcript, prompt input: raw_text truncated to last ~6000 chars
                                  (most-recent end of conversation).
    Output: JSON { match: bool, evidence: string | null }.
    Promise.allSettled — failed entries are dropped from results, counted
    for the footer note.
5. Render markdown:
     "**Checked {N} calls — {M} matched.**"
     - "{Company} · {YYYY-MM-DD} — \"{evidence}\""
     ...
     If failures > 0: "(N transcripts could not be evaluated this run.)"
   If M === 0: "**Checked {N} calls. None matched the criterion: {criterion}.**"
```

The 6000-char truncation takes the **end** of `raw_text`, not the beginning, because objections, pricing concerns, and "happy to chat more" signals tend to land in the back half of a discovery call. This is a deliberate bias.

### Orchestrator changes (`src/lib/ai/chat/orchestrator.ts`)

```ts
if (routed.kind === 'clarify')  return routed.clarify_question;
if (routed.kind === 'filter')   return runFilter({ filter: routed.filter, knowledgeDocs });
if (routed.kind === 'lookup')   return runLookup({ ... });   // existing
// fall through: scope → advocates + judge (existing)
```

`clarify` and `filter` skip the existing FTS retriever and lead-index build (those are only needed by lookup/scope). For `filter`, transcripts come from the executor's own ORDER BY-LIMIT query, not FTS.

### Model ID fix (`src/lib/constants.ts`)

```diff
-export const LOOKUP_MODEL  = 'deepseek/deepseek-v4-pro';
-export const ADVOCATE_MODEL = 'deepseek/deepseek-v4-pro';
-export const JUDGE_MODEL    = 'deepseek/deepseek-v4-pro';
+export const LOOKUP_MODEL   = 'deepseek/deepseek-chat-v3-0324';
+export const ADVOCATE_MODEL = 'deepseek/deepseek-chat-v3-0324';
+export const JUDGE_MODEL    = 'deepseek/deepseek-r1';
```

Fallback model lists in `lookup.ts`, `advocate.ts`, `judge.ts` get the same swap (`deepseek-v4-flash`, `deepseek-v3.2` → known-good DeepSeek slugs: `deepseek/deepseek-chat-v3-0324`, `deepseek/deepseek-r1`). The constraint from CLAUDE.md ("keep the chat on DeepSeek only") is preserved.

The new filter classifier reuses `LOOKUP_MODEL` (cheap, fast, JSON-mode capable). No new constant.

### OpenRouter wrapper hardening (`src/lib/ai/openrouter.ts`)

Two changes:

1. **Empty content is retryable.** Today the loop in `callAIMessages` retries on `API error 429` or `API error 5\d\d` only. Empty content throws and the loop bails. Change: tag the empty-content error so the retry predicate catches it, then try the next fallback model.

2. **Surface failed model ID.** Empty-content and non-OK errors include `model=<slug>` in the message so the next time this happens the founder sees which slug went dead without grepping.

```ts
const retryable = /API error (429|5\d\d)/.test(message)
              || /empty response/i.test(message);
```

## Data flow (filter path only)

```
POST /api/chat-sessions/:id/messages
  → answerInsightsChat → answerChat (orchestrator)
  → classifyQuestion (router) → kind='filter', criterion, n, criterion_type
  → runFilter
      ├─ supabase: SELECT ... transcripts ORDER BY created_at DESC LIMIT N
      ├─ stuffed (1 call) OR fan-out (≤N calls, ≤8 concurrent)
      └─ render markdown
  → persist as assistant message
  → return JSON to client
```

No new tables, no migrations, no new HTTP routes.

## Error handling

| Failure | Behavior |
|---|---|
| Router JSON parse fails | Existing fallback: classify as `scope`. Unchanged. |
| Router emits `kind='filter'` but no `filter` field | Treat as `lookup` and continue (defensive). |
| `n > 50` | Clamp to 50. Prevents accidental "for the last 1000" runaway. |
| DB query for transcripts errors | Bubble up to existing inline-error path; assistant message says "Failed to generate answer: {db error}". |
| Stuffed-mode AI call fails after fallbacks | Same as lookup path today — error surfaces in assistant message. |
| Fan-out: individual classifier call fails | `Promise.allSettled` — that transcript drops out. Footer notes count of failures. The whole filter does not fail. |
| Fan-out: every classifier call fails | Render: "Filter failed for all N transcripts. Try again." Do not pretend zero matches. |
| Empty response from OpenRouter on a single model | Now retryable in the fallback chain (see wrapper hardening). |

## Cost / latency expectations

- **Stuffed mode (N≤10, factual):** 1 LOOKUP_MODEL call, ~2-4s, ~$0.01 / question.
- **Fan-out mode (N=20, semantic):** ~20 small JSON classifier calls, concurrency 8 → ~3 batches × ~2s each = 6-8s wall time. Cost ~$0.05 / question on `deepseek-chat-v3-0324`.
- **Hard cap:** `n` clamped to 50. Worst-case fan-out = 50 calls / 8 concurrency = ~7 batches → ~14-18s wall time, well under the 120s `maxDuration` of the messages route.

## Testing

- Add small unit tests for the router prompt over a small golden set:
  - "for the last 20 calls, which were worried about privacy" → `filter`, n=20, criterion_type=`semantic`.
  - "which prospects mentioned Linear" → `lookup`. (Heuristic: no explicit N and no per-call iteration framing → lookup. The router prompt encodes this rule.)
  - "for all 50 prospects, who mentioned Linear" → `filter`, n=50, criterion_type=`factual`.
  - "what did Alex at Ramp say about onboarding" → `lookup`.
  - "should we cut Slack support from scope" → `scope`.
  - "what do you mean" → `clarify`.
- Add tests for the filter executor:
  - N clamping at 50.
  - Stuffed mode picked when factual + N≤10.
  - Fan-out mode picked when semantic regardless of N.
  - `Promise.allSettled` swallows individual failures and reports them in the footer.
- Manual smoke once shipped: re-run the original failing question against production transcripts; expect a list of matches or a clear "0 matched."

Per the project's verification side-effects rule, no happy-path hits on the chat endpoint during automated verification — exercise the unit-level pieces and rely on the manual smoke for end-to-end.

## Files touched

| File | Change |
|---|---|
| `src/lib/constants.ts` | Replace dead model slugs with valid DeepSeek IDs. |
| `src/lib/ai/openrouter.ts` | Make empty-content errors retryable; include model slug in error messages. |
| `src/lib/ai/chat/types.ts` | Extend `RouterOutput`; add `FilterSpec`. |
| `src/lib/ai/chat/router.ts` | Update prompt, parsing, and fallback to support 4 buckets. |
| `src/lib/ai/chat/filter.ts` | **New.** Filter executor with stuffed + fan-out modes. |
| `src/lib/ai/chat/orchestrator.ts` | Branch on `filter` and `clarify` kinds. |
| `src/lib/ai/chat/lookup.ts`, `advocate.ts`, `judge.ts` | Update fallback model lists. |
| `src/lib/ai/chat/__tests__/router.test.ts` (or similar) | Golden set for the 4-bucket classifier. |
| `src/lib/ai/chat/__tests__/filter.test.ts` | Mode selection + Promise.allSettled behavior. |

No UI changes in v1 — markdown output renders in the existing chat surface.

## Migration / rollout

No DB migration. The change is gated behind the existing `CHAT_DEBATE_ENABLED` env var implicitly (the new code lives under `answerChat`, which is only called when the flag is on). If the new path misbehaves in production, set `CHAT_DEBATE_ENABLED=false` and the chat falls back to the legacy single-call helper while the issue is debugged.

## Open follow-ups (out of scope for this spec)

- Filter results with action CTAs ("send security sheet to these 4 leads"). Would need a new follow-up_queue type and a UI affordance. Capture in a separate spec once the filter path is in use.
- Streaming partial results so the founder sees matches appear as fan-out progresses. Adds Server-Sent Events plumbing through `/api/chat-sessions/:id/messages` — meaningful complexity, defer until the value is proven.
- Filter over leads/interactions, not just transcripts (e.g., "for the last 20 inbound emails, which mentioned pricing"). Same shape, different table; add when there's a real ask.
