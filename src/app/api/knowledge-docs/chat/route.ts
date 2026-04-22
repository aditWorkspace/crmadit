export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';

const SYSTEM_PROMPT = `You are an AI assistant for Proxi AI, a startup building a PM command center (product prioritization tool). You help the founding team analyze insights from their prospect discovery calls.

You have access to:
1. **Knowledge Documents** — aggregated insights from all calls:
   - Problems & Pain Points — what prospects struggle with (per-lead entries)
   - Product Feedback — what prospects think about Proxi AI
   - Solutions & Ideas — workflow ideas, feature requests, how prospects would use Proxi
   - Problem Themes — AI-aggregated patterns showing common problems across all prospects, with frequency counts and lead attribution
2. **Raw Call Transcripts** — full text from individual discovery calls

Rules:
- Answer based ONLY on the provided documents and transcripts. Do not make up information.
- Cite specific prospect names, companies, and dates when available.
- When asked about a specific call or company, search the raw transcripts.
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

  // Fetch recent transcripts with lead info
  const { data: transcripts } = await supabase
    .from('transcripts')
    .select(`id, raw_text, ai_summary, created_at, leads!inner(contact_name, company_name)`)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false })
    .limit(20);

  // Build context from all docs
  const docsContext = (docs || [])
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');

  // Build transcript context (truncate each to ~4000 chars to avoid token overflow)
  const transcriptContext = (transcripts || [])
    .map(t => {
      const lead = t.leads as unknown as { contact_name: string; company_name: string } | null;
      const header = `=== TRANSCRIPT: ${lead?.contact_name || 'Unknown'} (${lead?.company_name || 'Unknown'}) - ${t.created_at?.slice(0, 10)} ===`;
      const summary = t.ai_summary ? `Summary: ${t.ai_summary}\n\n` : '';
      const rawText = (t.raw_text || '').slice(0, 4000);
      return `${header}\n${summary}${rawText}`;
    })
    .join('\n\n---\n\n');

  const userMessage = `Here are the knowledge documents:

${docsContext}

---

Here are the raw call transcripts:

${transcriptContext}

---

Question: ${question}`;

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
