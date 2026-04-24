import { callAI } from '@/lib/ai/openrouter';
import { CHAT_ROUTER_MODEL } from '@/lib/constants';
import type { RouterOutput } from './types';

const SYSTEM_PROMPT = `You classify insight-chat questions for a founder analyzing prospect discovery calls.

Output strict JSON only:
{
  "kind": "lookup" | "scope",
  "search_terms": ["term1", "term2", ...]
}

**lookup** = factual query about a specific prospect, call, count, or recent fact. No judgment required.
  Examples:
    - "what did Alex at Ramp say about onboarding?"
    - "which prospects are in the scheduling stage?"
    - "summarize the 2026-04-12 call with Linear"

**scope** = asks whether to build/prioritize something, whether customers care, whether a pattern is real, what prospects think about X, what the product should focus on. Anything that requires weighing evidence or reaching a conclusion.
  Examples:
    - "do prospects actually want a Slack integration?"
    - "is onboarding friction a real pattern or just 1-2 people?"
    - "what should we cut from scope?"

When in doubt, classify as scope — cheap to debate, expensive to miss.

**search_terms**: 3–5 keywords or short phrases. Expand with close synonyms and related domain terms.
  - Start from words in the user's question
  - Add adjacent concepts that prospects would naturally use (e.g. "Slack" → also "messaging", "notifications", "chat")
  - Each term should be 1–4 words. Plain nouns/noun phrases, no stopwords.
  - These feed Postgres full-text search. Be generous but not noisy.`;

export async function classifyQuestion(question: string): Promise<RouterOutput> {
  const raw = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `Question: ${question}`,
    model: CHAT_ROUTER_MODEL,
    jsonMode: true,
    maxTokens: 200,
  });

  try {
    const parsed = JSON.parse(raw);
    const kind = parsed.kind === 'lookup' ? 'lookup' : 'scope';
    const terms = Array.isArray(parsed.search_terms)
      ? parsed.search_terms.filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    return { kind, search_terms: terms };
  } catch {
    // Router failure -> assume scope (safer) and fall back to question words.
    return {
      kind: 'scope',
      search_terms: question
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5),
    };
  }
}
