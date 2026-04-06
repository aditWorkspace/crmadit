import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { thread_id, context_type } = await req.json();
  if (!thread_id) return NextResponse.json({ error: 'thread_id required' }, { status: 400 });

  const supabase = createAdminClient();

  const [leadRes, interactionsRes] = await Promise.all([
    supabase.from('leads').select('contact_name, company_name').eq('id', id).single(),
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

  const threadText = thread
    .map(i => {
      const role = i.type === 'email_inbound' ? lead.contact_name : 'Me';
      return `[${role}]: ${(i.body || '').slice(0, 300)}`;
    })
    .join('\n\n');

  const isPostCall = context_type === 'post_call';
  const draft = await callAI({
    model: 'deepseek/deepseek-chat-v3-0324',
    systemPrompt: `You are a sales assistant drafting a follow-up email.

Rules:
- Short and professional, 2-4 sentences max
- No em-dashes (—), use commas or periods instead
- No filler phrases ("I hope this finds you well", "Just following up")
- Reference the conversation naturally
- End with a clear next step or question
- Sign off with just the sender's first name on a new line
- Output ONLY the email body, no subject line, no "Dear X"${isPostCall ? '\n- This is a post-call follow-up: thank them briefly for the call, reference one specific thing discussed, and propose a clear next step' : ''}`,
    userMessage: `Contact: ${lead.contact_name} at ${lead.company_name}

Email thread (oldest first):
${threadText}

Draft a short professional ${isPostCall ? 'post-call follow-up' : 'follow-up reply'}.`,
  });

  return NextResponse.json({ draft });
}
