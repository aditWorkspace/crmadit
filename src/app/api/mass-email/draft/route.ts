export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';
import { STAGE_LABELS } from '@/lib/constants';
import { LeadStage } from '@/types';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { stage, context } = await req.json() as { stage?: string; context?: string };

  const stageLabel = stage ? STAGE_LABELS[stage as LeadStage] || stage : 'prospects';

  const result = await callAI({
    model: 'deepseek/deepseek-chat-v3-0324',
    systemPrompt: `You are a sales email assistant for Proxi AI, a product prioritization tool for PMs.
The team is 2 Berkeley co-founders (Adit, Asim) doing outbound outreach to PMs and CEOs.

Write a short, professional mass email to send to multiple prospects at the "${stageLabel}" stage.

Rules:
- 3-6 sentences max, direct and casual (Berkeley startup founder tone)
- No em-dashes (—), use commas or periods
- No filler ("I hope this finds you well")
- Reference Proxi AI naturally
- Include a clear call-to-action
- Sign off with just "Adit" on a new line
- Output a JSON object with "subject" and "body" fields only
- The body should NOT include "Dear X" or any salutation — it goes to many people`,
    userMessage: `Stage: ${stageLabel}
${context ? `Additional context: ${context}` : ''}

Generate a mass email for prospects at this stage. Return JSON: { "subject": "...", "body": "..." }`,
    jsonMode: true,
  });

  try {
    const parsed = JSON.parse(result);
    return NextResponse.json({ subject: parsed.subject, body: parsed.body });
  } catch {
    return NextResponse.json({ subject: '', body: result });
  }
}
