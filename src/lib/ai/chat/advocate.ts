import { callAIMessages, type AiMessage } from '@/lib/ai/openrouter';
import { ADVOCATE_MODEL } from '@/lib/constants';
import type { AdvocateOutput, HistoryMessage } from './types';

const ADVOCATE_PROMPT = (side: 'for' | 'against') => `You are an advocate in a structured debate about prospect-call evidence for a startup founder (Proxi AI — a PM command center).

Your side: **${side.toUpperCase()}** the user's claim.

Your job is to build the STRONGEST HONEST case for your side using the transcripts and knowledge docs provided. Rules:

1. Quote prospects by name and company. Prefer direct quotes from the "Key quotes" section of each card. If you must paraphrase, mark it as paraphrase.
2. Do NOT argue the other side — another advocate is doing that. Stay in role.
3. Do NOT fabricate. If a card doesn't contain a quote or fact you want, skip it or mark it as inference. The judge will check you.
4. If the evidence for your side is thin, make the best case you can and flag the thinness in one closing sentence. Do NOT pre-concede the debate.
5. Reference the LEAD INDEX to note prospects who are NOT in the retrieved cards but MIGHT be relevant ("Worth checking Xyz @ Foo — they didn't surface in retrieval but their stage is active_user").
6. Target 200–350 words.

Output format (plain prose, no markdown headers):
[Your argument as 1-3 paragraphs, quoting prospects by name.]

Evidence-thinness note (if applicable): [one sentence]`;

interface RunAdvocateArgs {
  side: 'for' | 'against';
  question: string;
  history: HistoryMessage[];
  retrievedCards: string;
  leadIndex: string;
  knowledgeDocs: string;
}

export async function runAdvocate(args: RunAdvocateArgs): Promise<AdvocateOutput> {
  const systemPrompt = ADVOCATE_PROMPT(args.side);

  const contextMessage = `## LEAD INDEX (every transcript on file)

${args.leadIndex}

---

## RETRIEVED PROFILE CARDS (most relevant to this question)

${args.retrievedCards}

---

## KNOWLEDGE DOCS (aggregated across all calls)

${args.knowledgeDocs}

---

## USER QUESTION

${args.question}

Argue ${args.side.toUpperCase()} the user's claim now.`;

  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...args.history.map(h => ({ role: h.role, content: h.content } as AiMessage)),
    { role: 'user', content: contextMessage },
  ];

  const argument = await callAIMessages({
    messages,
    model: ADVOCATE_MODEL,
    maxTokens: 800,
  });

  return { side: args.side, argument };
}
