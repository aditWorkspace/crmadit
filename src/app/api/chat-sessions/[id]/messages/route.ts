export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { answerInsightsChat } from '@/lib/ai/chat-helper';
import type { HistoryMessage } from '@/lib/ai/chat/types';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { message } = await req.json();
  if (!message?.trim()) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const supabase = createAdminClient();

  // Verify ownership
  const { data: chatSession, error: sessionErr } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('id', id)
    .eq('team_member_id', session.id)
    .single();

  if (sessionErr || !chatSession) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Pull prior messages for history (ascending order). We take the last 12
  // inside the orchestrator; fetching all is fine at this scale.
  const { data: priorMessages } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('session_id', id)
    .order('created_at', { ascending: true });

  const history: HistoryMessage[] = (priorMessages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Insert user message
  const { data: userMsg, error: userErr } = await supabase
    .from('chat_messages')
    .insert({ session_id: id, role: 'user', content: message })
    .select('id, role, content, created_at')
    .single();

  if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });

  // Get AI answer
  try {
    const answer = await answerInsightsChat(message, history);

    const { data: assistantMsg, error: assistantErr } = await supabase
      .from('chat_messages')
      .insert({ session_id: id, role: 'assistant', content: answer })
      .select('id, role, content, created_at')
      .single();

    if (assistantErr) return NextResponse.json({ error: assistantErr.message }, { status: 500 });

    await supabase
      .from('chat_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    return NextResponse.json({ userMessage: userMsg, assistantMessage: assistantMsg });
  } catch (err) {
    return NextResponse.json({
      error: 'Failed to generate answer',
      details: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
