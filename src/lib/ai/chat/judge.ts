import { callAIMessages, type AiMessage } from '@/lib/ai/openrouter';
import { JUDGE_MODEL } from '@/lib/constants';
import type { AdvocateOutput, HistoryMessage } from './types';

const JUDGE_PROMPT = `You are the JUDGE in a structured debate about prospect-call evidence.

Two advocates have argued opposing sides of the founder's question — one FOR the claim, one AGAINST. Your job is to reach the CORRECT conclusion, not a diplomatic one.

Core rules:
1. If FOR is clearly right, say so and briefly explain why AGAINST's case was weak.
2. If AGAINST is right, same.
3. If evidence is genuinely mixed, say "mixed" and name the specific condition that would resolve it (e.g. "would need to ask prospects directly about X").
4. Do NOT hedge. Do NOT split the difference to be polite. Your primary failure mode is agreeing with whichever advocate sounded more confident — guard against that.
5. The founder is scoping a product. A narrower, disciplined answer is more useful than a broad one — push back against "build everything."
6. Evidence quality matters more than volume. One specific quote from an active_user beats three vague paraphrases from scheduling-stage prospects.
7. Acknowledge selection bias where it matters: the prospects on file all self-selected into replying to outreach about "product prioritization." They are NOT a random sample of PMs.

**Clarifier escape hatch.** If the question is genuinely ambiguous or relies on a premise you cannot verify from the cards, skip the debate output entirely and reply ONLY with:

> Before I answer — [1-2 specific clarifying questions].

Use this sparingly. Target: ~20–30% of scope questions get a clarifier. Do NOT use it as a cop-out when you have enough evidence to take a position.

**Normal output format.** Plain text, no code fences. Use these exact section headers in bold:

**Conclusion.** (1 sentence — the answer.)

**Why I think so.** (2–4 bullet points, each citing a named prospect or knowledge-doc pattern. Prefer direct quotes from the evidence.)

**Why I could be wrong.** (2–3 bullet points of genuine counter-evidence, not performative hedging. If counter-evidence is absent, say "no prospect on file contradicts this, but only N of 70 spoke to it.")

**My call.** (1–2 sentences — concrete guidance for the founder.)`;

interface RunJudgeArgs {
  question: string;
  history: HistoryMessage[];
  advocates: [AdvocateOutput, AdvocateOutput];
  leadIndex: string;
  retrievedCards: string;
}

export async function runJudge(args: RunJudgeArgs): Promise<string> {
  const forArg = args.advocates.find(a => a.side === 'for')?.argument || '(FOR advocate produced nothing)';
  const againstArg = args.advocates.find(a => a.side === 'against')?.argument || '(AGAINST advocate produced nothing)';

  const userMessage = `## USER QUESTION

${args.question}

---

## ADVOCATE FOR (arguing the user's claim is correct)

${forArg}

---

## ADVOCATE AGAINST (arguing the user's claim is wrong)

${againstArg}

---

## LEAD INDEX (for sanity-checking advocate claims against the full transcript roster)

${args.leadIndex}

---

## RETRIEVED EVIDENCE CARDS (what both advocates saw — use to verify quotes)

${args.retrievedCards}

---

Render your judgment now.`;

  const messages: AiMessage[] = [
    { role: 'system', content: JUDGE_PROMPT },
    ...args.history.map(h => ({ role: h.role, content: h.content } as AiMessage)),
    { role: 'user', content: userMessage },
  ];

  return callAIMessages({
    messages,
    model: JUDGE_MODEL,
    maxTokens: 1500,
  });
}
