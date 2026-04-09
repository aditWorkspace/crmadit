export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';

const SYSTEM_PROMPT = `You are an AI assistant for Proxi AI, a startup building a PM command center (product prioritization tool). You help the founding team analyze insights from their prospect discovery calls.

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

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: 'Question is required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: docs, error } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content')
    .order('doc_type');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Build context from all docs
  const docsContext = (docs || [])
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');

  const userMessage = `Here are the knowledge documents:\n\n${docsContext}\n\n---\n\nQuestion: ${question}`;

  try {
    const answer = await callAI({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
    });

    return NextResponse.json({ answer });
  } catch (err) {
    return NextResponse.json({
      error: 'Failed to generate answer',
      details: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
