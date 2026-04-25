# Insights Chat: Debate Architecture

**Date:** 2026-04-23
**Status:** Approved for implementation
**Scope:** Replace the single-call chat backend on `/insights` with a multi-agent debate pipeline that produces calibrated, anti-sycophantic answers grounded in transcript evidence.

## Problem

The current `/insights` chat uses `getAIAnswer()` → one DeepSeek v3 call → knowledge docs only. Three concrete failures:

1. **No transcript access from the UI path.** `chat-helper.ts` only passes the four aggregated knowledge docs. The orphaned `/api/knowledge-docs/chat` route does include transcripts, but nothing calls it. The founder is reasoning from post-digested abstractions, not the prospects' actual words.
2. **No conversation history.** Messages are stored in `chat_messages` but never sent back to the model. Every turn is context-free.
3. **Sycophancy surface.** Default DeepSeek + a polite "be concise" prompt reliably glazes. No mechanism forces the model to weigh counter-evidence.

## Goal

Founder uses the chat to narrow product scope. The chat must report **what the evidence actually shows** — agreeing when prospects support a claim, disagreeing with specific citations when they contradict it, asking clarifiers when a question is genuinely ambiguous, and flagging thin evidence honestly. Neutral calibration, not contrarian or agreeable posture.

## Architecture

### Per-turn pipeline

```
User question
  ↓
Router (DeepSeek v3)           ← classifies LOOKUP vs SCOPE, emits 3–5 FTS search terms
  ↓
Retriever (Postgres FTS)       ← top-8 transcripts by ts_rank
  ↓
Build context:
  - Lead index (one-liner × all transcripts)
  - Retrieved profile cards (rich summaries built from existing ai_* fields)
  - Knowledge docs (existing 4)
  - Conversation history (last 6 turns, capped)
  ↓
┌────────────────────────────┬────────────────────────────┐
│ if LOOKUP:                 │ if SCOPE:                  │
│   Lookup (Sonnet 4.5)       │   Advocate FOR  (Haiku 4.5)│
│   → direct answer           │   Advocate AGAINST (Haiku) │
│                            │   ↓ (parallel)             │
│                            │   Judge (Opus 4)           │
│                            │   → deliberated answer     │
└────────────────────────────┴────────────────────────────┘
  ↓
Response to user
```

### Model routing

| Stage | Model | Env constant |
|---|---|---|
| Router | `deepseek/deepseek-chat-v3-0324` | reuses existing `DECIDER_MODEL` |
| Lookup (single-call) | `anthropic/claude-sonnet-4-20250514` | `LOOKUP_MODEL` |
| Advocate FOR / AGAINST | `anthropic/claude-haiku-4-5` | `ADVOCATE_MODEL` |
| Judge | `deepseek/deepseek-v4-pro` (temp; togglable) | `JUDGE_MODEL` |

Opus is the only judge-level call. Budget-preserving.

**Cost expectation.** Scope-question turn ≈ $0.27. Lookup turn ≈ $0.05. Mixed 20 turns ≈ $3–5. Hard cap of $5 / 20 turns met.

### Retrieval: Postgres FTS (no embeddings)

Migration `014_transcript_fts.sql`:

- Add `fts` column (`tsvector`, generated) to `transcripts` combining `raw_text`, `ai_summary`, and text-stringified `ai_pain_points`, `ai_product_feedback`, `ai_key_quotes`.
- GIN index on `fts`.
- Generated column means no trigger — updates automatically on row write.

Router emits 3–5 search terms. Retriever runs `ts_rank_cd` against the generated `tsvector`, returns top 8 transcripts with their lead join. If router classifies LOOKUP, retrieve anyway (lookup answers still benefit from citations).

### Lead index

One line per completed transcript: `<contact_name> @ <company> (<date>, stage=<stage>): <≤100-char theme from ai_summary>`. Built from a single join query. Always in context so the model knows what else exists — critical against the RAG-overfit failure mode.

### Profile cards

Rich summary of a single transcript, built from existing `ai_*` columns (no new AI call):

```
=== <name> @ <company> — <date> ===
Sentiment: <sentiment> | Interest: <interest>
Summary: <ai_summary>
Pain points: - [<severity>] <pain_point> ...
Feedback:    - [<category>] <feedback> ...
Key quotes:  - "<quote>" — <speaker> (<context>)
Suggested follow-ups: - <action> (<timing>) — <reason>
```

### Conversation history

API routes fetch last 6 message pairs from `chat_messages` before calling the orchestrator. Passed as a `messages[]` array into OpenRouter. `callAI()` extended to accept pre-built messages; current callers keep working.

## Prompts

### Router
> Classify the user's question. Output JSON only:
> `{ "kind": "lookup" | "scope", "search_terms": ["..."] }`
>
> **lookup** = factual query about a specific prospect, call, count, or recent fact. No judgment required.
> **scope** = asks whether to build/prioritize something, whether customers care, whether a pattern is real, what prospects think about X. Anything requiring weighing evidence.
>
> `search_terms` = 3–5 keywords/phrases from the question, expanded with close synonyms and domain terms. These will be used in Postgres full-text search against transcripts.

### Advocate (side = "for" | "against")
> You are an advocate in a structured debate about prospect data. Your side: **{side}** the user's claim.
>
> Build the **strongest honest case** for your side using the transcripts below. Rules:
> - Quote prospects by name and company. Prefer direct quotes.
> - Do NOT argue the other side — that's another advocate's job.
> - Do NOT fabricate quotes. If a transcript doesn't contain a quote, paraphrase and say so.
> - If the evidence for your side is thin, make the best case you can and flag the thinness in one closing sentence. Don't pre-concede.
> - Target 200–350 words.

### Judge (Opus)
> You are the judge. Two advocates have argued opposing sides of the user's question. Your job is to reach the **correct** conclusion, not a diplomatic one.
>
> - If FOR is clearly right, say so and explain why AGAINST's case was weak.
> - If AGAINST is right, same.
> - If evidence is genuinely mixed, say "mixed" and name the specific condition that would resolve it.
> - Do NOT hedge. Do NOT split the difference to be polite. Your primary failure mode is agreeing with whichever advocate sounded more confident — guard against that.
> - The founder is scoping a product. A narrower, disciplined answer is more useful than a broad one.
>
> Output format:
> **Conclusion.** (1 sentence)
> **Why I think so.** (2–4 bullets, cite prospects)
> **Why I could be wrong.** (2–3 bullets, named counter-evidence or honest "the evidence doesn't speak to this")
> **My call.** (1–2 sentences: concrete guidance)
>
> If the user's question was genuinely ambiguous, replace the whole output with a single clarifier: "Before I answer, I want to check — [specific question about scope]." Use this sparingly (~20–30% of scope questions).

### Lookup (Sonnet)
> Answer the factual question from the transcripts and knowledge docs below. Cite specific prospects by name/company/date. If the data doesn't answer the question, say so plainly — do not generalize to fill the gap. No debate structure needed; just the answer.

## Data / API changes

### New files
- `supabase/migrations/014_transcript_fts.sql`
- `src/lib/ai/chat/profile-card.ts`
- `src/lib/ai/chat/lead-index.ts`
- `src/lib/ai/chat/retriever.ts`
- `src/lib/ai/chat/router.ts`
- `src/lib/ai/chat/advocate.ts`
- `src/lib/ai/chat/judge.ts`
- `src/lib/ai/chat/lookup.ts`
- `src/lib/ai/chat/orchestrator.ts`

### Modified files
- `src/lib/ai/openrouter.ts` — add `callAIMessages()` that accepts a full messages array; keep existing `callAI()` untouched.
- `src/lib/constants.ts` — add `LOOKUP_MODEL`, `ADVOCATE_MODEL`, `JUDGE_MODEL`, `CHAT_ROUTER_MODEL`.
- `src/lib/ai/chat-helper.ts` — `getAIAnswer()` becomes `answerChat({ question, history })`, delegates to orchestrator.
- `src/app/api/chat-sessions/route.ts` and `[id]/messages/route.ts` — fetch prior messages, pass to helper.

## Feature flag

Env var `CHAT_DEBATE_ENABLED` (default `true` in dev). If `false`, chat-helper falls back to the old single-call path. Provides a fast rollback if Opus/advocates misbehave.

## Out of scope

- No embeddings / pgvector. FTS only.
- No tool-calling (raw-transcript read-back tool). Profile cards include enough quotes.
- No UI changes. Output shape fits into existing `FormattedMarkdown` renderer.
- No changes to `knowledge_docs` aggregation pipeline.
- No cost metering / usage dashboard (trust the model routing).

## Risks

1. **Advocates fabricate quotes.** Mitigation: retrieve cards contain actual quotes with speakers; advocate prompt forbids fabrication; judge has the same cards and will notice divergence.
2. **Opus judge model ID wrong on OpenRouter.** Mitigation: constants in one file, easy to fix; single env var to disable debate and fall back.
3. **Judge agrees with the confident advocate ("confidence bias").** Mitigation: explicit anti-pattern in judge prompt; we can A/B the prompt after use.
4. **Router mis-classifies and scope questions skip debate.** Mitigation: "when in doubt, scope" rule in router prompt; judge debate is cheap enough at Haiku prices.

## Success criteria

1. Asking "do customers care about Slack integration?" cites specific prospects for and against in the same answer.
2. Asking a premise the transcripts contradict (e.g. "customers want a full PM suite — which ones said that?") yields explicit disagreement, not agreement.
3. Conversation history works — "tell me more about that" after a Slack question stays on-topic.
4. Lookups ("who was at the Acme call?") return a terse direct answer without debate overhead.
5. Cost of 20 mixed prompts stays ≤ $5.
