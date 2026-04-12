export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';
import { BOOKING_URL } from '@/lib/constants';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { thread_id, context_type } = await req.json();
  if (!thread_id) return NextResponse.json({ error: 'thread_id required' }, { status: 400 });

  const supabase = createAdminClient();

  const [leadRes, interactionsRes] = await Promise.all([
    supabase.from('leads').select('contact_name, company_name, stage').eq('id', id).single(),
    supabase
      .from('interactions')
      .select('type, subject, body, occurred_at, team_member:team_members(name)')
      .eq('lead_id', id)
      .eq('gmail_thread_id', thread_id)
      .in('type', ['email_inbound', 'email_outbound'])
      .order('occurred_at', { ascending: true })
      .limit(8),
  ]);

  if (!leadRes.data) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  const lead = leadRes.data;
  const thread = interactionsRes.data || [];

  // Get sender name for thread context (Bug #6 fix — null safety)
  const senderName = session.name || 'our team';

  const threadText = thread
    .map(i => {
      const role = i.type === 'email_inbound' ? lead.contact_name : senderName;
      return `[${role}]: ${(i.body || '').slice(0, 300)}`;
    })
    .join('\n\n');

  const isPostCall = context_type === 'post_call';
  const stage = lead.stage || 'replied';

  // Stage-specific instructions for smarter replies
  const stageInstructions: Record<string, string> = {
    replied: `\n- IMPORTANT: Read the prospect's last message carefully to determine their intent before drafting.
  * If they are POSITIVE about a call ("sure", "happy to chat", "send me a time", "let's do it", "what's your availability"): thank them briefly and include this exact booking link: ${BOOKING_URL}. Do NOT ask questions about their workflow. Just send the link.
  * If they want to do things ASYNC ("don't have time for a call", "send me more info", "what are you building"): ask 2-3 specific questions about how they prioritize at their company and what tools they use. Do NOT include the booking link. Do NOT explain what Proxi does.
  * If they sent their OWN calendar link (Calendly, Cal.com, SavvyCal): acknowledge it and say you'll book a time. Do NOT send our booking link.
  * If they asked a specific QUESTION (pricing, integrations, features): answer briefly if you can, or say you'd love to discuss on a quick call and include the booking link: ${BOOKING_URL}
  * If they DECLINED: do not draft a response. Return an empty string.`,
    scheduling: `\n- We are trying to schedule a call. If they proposed a time, confirm it. If there is a conflict, suggest 2-3 alternative times. If they need a booking link, share: ${BOOKING_URL}`,
    scheduled: '\n- A call is already scheduled. Send a brief confirmation or pre-call note. Keep it simple.',
    call_completed: '\n- The discovery call is done. Thank them briefly, reference one specific thing from the conversation, and propose a clear next step (e.g., sending the product demo).',
    post_call: '\n- This is the post-call follow-up phase. Thank them for the call, reference a key takeaway, and outline the agreed next steps (e.g., sending demo access, scheduling a follow-up).',
    demo_sent: '\n- We sent them a product demo/MVP. Follow up to see if they have tried it and gather initial feedback.',
  };

  const stageHint = stageInstructions[stage] || '';

  const draft = await callAI({
    model: 'deepseek/deepseek-chat-v3-0324',
    systemPrompt: `You are a sales assistant for Proxi AI (a product prioritization tool for PMs), drafting a follow-up email on behalf of a Berkeley startup founder.

Rules:
- Short and professional, 2-4 sentences max
- NEVER use em dashes (the — character). Use commas or periods instead. This rule is absolute.
- NEVER describe, explain, or pitch what Proxi does or builds. Do not say "our product" or "we're building". Sound like a curious student, not a salesperson.
- No filler phrases ("I hope this finds you well", "Just following up")
- Reference the conversation naturally
- End with a clear next step or question
- Sign off with just the sender's first name on a new line
- Output ONLY the email body, no subject line, no "Dear X"${isPostCall ? '\n- This is a post-call follow-up: thank them briefly for the call, reference one specific thing discussed, and propose a clear next step' : ''}${stageHint}`,
    userMessage: `Contact: ${lead.contact_name} at ${lead.company_name}
Current pipeline stage: ${stage}

Email thread (oldest first):
${threadText}

Draft a short professional ${isPostCall ? 'post-call follow-up' : 'follow-up reply'}.`,
  });

  // Post-process: scrub em dashes the model may have slipped in
  const scrubbed = draft
    .replaceAll('—', ', ')
    .replaceAll('–', ', ')
    .replace(/\s+,/g, ',')
    .trim();

  return NextResponse.json({ draft: scrubbed });
}
