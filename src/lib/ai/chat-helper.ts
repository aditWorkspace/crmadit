import { createAdminClient } from '@/lib/supabase/admin';
import { callAI } from '@/lib/ai/openrouter';
import { answerChat } from '@/lib/ai/chat/orchestrator';
import type { HistoryMessage } from '@/lib/ai/chat/types';

// Feature flag. Default on. Flip CHAT_DEBATE_ENABLED=false to revert to the
// single-call knowledge-docs-only path.
function debateEnabled(): boolean {
  return process.env.CHAT_DEBATE_ENABLED !== 'false';
}

// Primary entry point for the insights chat.
//   - If CHAT_DEBATE_ENABLED is on (default), runs the router → retriever →
//     (advocates|lookup) → judge pipeline with transcript evidence and
//     conversation history.
//   - Otherwise falls back to the legacy single DeepSeek call over just the
//     four knowledge docs.
export async function answerInsightsChat(
  question: string,
  history: HistoryMessage[] = [],
): Promise<string> {
  if (debateEnabled()) {
    return answerChat({ question, history });
  }
  return legacySingleCall(question);
}

// Back-compat shim. Some callers still import getAIAnswer with just a
// question string. Stays on the legacy path since those callers don't have
// history plumbed through.
export async function getAIAnswer(question: string): Promise<string> {
  return answerInsightsChat(question, []);
}

const LEGACY_SYSTEM_PROMPT = `You are an AI assistant for Proxi AI, a startup building a PM command center (product prioritization tool). You help the founding team analyze insights from their prospect discovery calls.

You have access to four knowledge documents that accumulate insights from all calls:
1. Problems & Pain Points — what prospects struggle with (per-lead entries)
2. Product Feedback — what prospects think about Proxi AI
3. Solutions & Ideas — workflow ideas, feature requests, how prospects would use Proxi
4. Problem Themes — AI-aggregated patterns showing common problems across all prospects, with frequency counts and lead attribution

Rules:
- Answer based ONLY on the provided documents. Do not make up information.
- Cite specific prospect names, companies, and dates when available.
- If the documents don't contain relevant information, say so clearly.
- Be concise and actionable — the founders are busy.
- When asked about patterns or trends, look across multiple entries for common themes.`;

async function legacySingleCall(question: string): Promise<string> {
  const supabase = createAdminClient();
  const { data: docs, error } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content')
    .order('doc_type');

  if (error) throw new Error(error.message);

  const docsContext = (docs || [])
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');

  return callAI({
    systemPrompt: LEGACY_SYSTEM_PROMPT,
    userMessage: `Here are the knowledge documents:\n\n${docsContext}\n\n---\n\nQuestion: ${question}`,
  });
}
