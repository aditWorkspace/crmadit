export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';
import { ProblemThemesData } from '@/types';

const AGGREGATION_PROMPT = `You are analyzing discovery call insights for Proxi AI, a startup building a PM command center. You are given pain points extracted from multiple prospect calls, each attributed to a specific lead.

Your job: group similar pain points into THEMES — recurring problems across prospects.

Rules:
- Group pain points that describe the same underlying problem, even if worded differently.
- Do NOT over-consolidate. If two prospects describe slightly different aspects of a problem, keep them as separate themes.
- Even if only ONE prospect mentions a pain point, still include it as its own theme — the lead pool is small.
- Severity per theme: use the highest severity among its constituent pain points.
- Rank themes by importance: frequency × severity weight (high=3, medium=2, low=1), descending.
- Preserve each lead's original pain_point text in the "leads" array for attribution.

Return JSON:
{
  "themes": [
    {
      "theme": "Clear, specific theme title describing the problem pattern",
      "severity": "high | medium | low",
      "frequency": 2,
      "leads": [
        { "name": "Heath Branum", "company": "Stackpack", "pain_point": "their original text" }
      ]
    }
  ],
  "generated_at": "ISO timestamp"
}

Return ONLY valid JSON, no markdown fences.`;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Fetch all completed transcripts with pain points, joined to lead info
  const { data: transcripts, error: fetchErr } = await supabase
    .from('transcripts')
    .select('ai_pain_points, leads!inner(contact_name, company_name)')
    .not('ai_pain_points', 'is', null)
    .eq('processing_status', 'completed');

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  if (!transcripts || transcripts.length === 0) {
    // No transcripts — store empty themes
    const emptyData: ProblemThemesData = { themes: [], generated_at: new Date().toISOString() };
    await supabase
      .from('knowledge_docs')
      .update({ content: JSON.stringify(emptyData), updated_at: new Date().toISOString() })
      .eq('doc_type', 'problem_themes');
    return NextResponse.json({ success: true, theme_count: 0 });
  }

  // Flatten into tuples for the AI
  const painPoints: Array<{ lead_name: string; company: string; pain_point: string; severity: string }> = [];

  for (const t of transcripts) {
    const lead = t.leads as unknown as { contact_name: string; company_name: string } | null;
    const points = t.ai_pain_points as Array<{ pain_point: string; severity: string }> | null;
    if (!lead || !points) continue;

    for (const p of points) {
      painPoints.push({
        lead_name: lead.contact_name,
        company: lead.company_name,
        pain_point: p.pain_point,
        severity: p.severity,
      });
    }
  }

  if (painPoints.length === 0) {
    const emptyData: ProblemThemesData = { themes: [], generated_at: new Date().toISOString() };
    await supabase
      .from('knowledge_docs')
      .update({ content: JSON.stringify(emptyData), updated_at: new Date().toISOString() })
      .eq('doc_type', 'problem_themes');
    return NextResponse.json({ success: true, theme_count: 0 });
  }

  try {
    const raw = await callAI({
      systemPrompt: AGGREGATION_PROMPT,
      userMessage: `Here are ${painPoints.length} pain points from ${transcripts.length} discovery calls:\n\n${JSON.stringify(painPoints, null, 2)}`,
      jsonMode: true,
    });

    const result: ProblemThemesData = JSON.parse(raw);
    result.generated_at = new Date().toISOString();

    await supabase
      .from('knowledge_docs')
      .update({ content: JSON.stringify(result), updated_at: new Date().toISOString() })
      .eq('doc_type', 'problem_themes');

    return NextResponse.json({ success: true, theme_count: result.themes.length });
  } catch (err) {
    console.error('[aggregate-themes] Failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Aggregation failed' },
      { status: 500 },
    );
  }
}
