import { callAIMessages, type AiMessage } from '@/lib/ai/openrouter';
import { LOOKUP_MODEL } from '@/lib/constants';
import type { HistoryMessage } from './types';

const LOOKUP_PROMPT = `You are a factual assistant for a founder analyzing prospect discovery calls.

This is a LOOKUP question — no debate structure, no conclusion sections. Just answer directly using the transcripts and knowledge docs below.

Rules:
- Cite specific prospects by name/company/date.
- If the data doesn't answer the question, say so plainly. Do NOT generalize or invent to fill the gap.
- Be concise. If a 2-sentence answer is complete, give a 2-sentence answer.
- Do NOT add "Conclusion / Why / Why I could be wrong" sections — this is a direct answer, not a judgment.`;

interface RunLookupArgs {
  question: string;
  history: HistoryMessage[];
  retrievedCards: string;
  leadIndex: string;
  knowledgeDocs: string;
}

export async function runLookup(args: RunLookupArgs): Promise<string> {
  const userMessage = `## LEAD INDEX

${args.leadIndex}

---

## RETRIEVED TRANSCRIPT CARDS

${args.retrievedCards}

---

## KNOWLEDGE DOCS

${args.knowledgeDocs}

---

## QUESTION

${args.question}`;

  const messages: AiMessage[] = [
    { role: 'system', content: LOOKUP_PROMPT },
    ...args.history.map(h => ({ role: h.role, content: h.content } as AiMessage)),
    { role: 'user', content: userMessage },
  ];

  return callAIMessages({
    messages,
    model: LOOKUP_MODEL,
    maxTokens: 1200,
    timeoutMs: 60_000,
    fallbackModels: ['deepseek/deepseek-r1'],
  });
}
