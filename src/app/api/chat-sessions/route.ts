export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { answerInsightsChat } from '@/lib/ai/chat-helper';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, title, updated_at')
    .eq('team_member_id', session.id)
    .order('updated_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data || [] });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { message } = await req.json();
  if (!message?.trim()) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

  const supabase = createAdminClient();
  const title = message.length > 50 ? message.slice(0, 50).trim() + '...' : message;

  // Create session
  const { data: chatSession, error: sessionErr } = await supabase
    .from('chat_sessions')
    .insert({ team_member_id: session.id, title })
    .select('id, title, updated_at')
    .single();

  if (sessionErr) return NextResponse.json({ error: sessionErr.message }, { status: 500 });

  // Insert user message
  const { data: userMsg, error: userErr } = await supabase
    .from('chat_messages')
    .insert({ session_id: chatSession.id, role: 'user', content: message })
    .select('id, role, content, created_at')
    .single();

  if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });

  // Get AI answer (new session -> no prior history).
  try {
    const answer = await answerInsightsChat(message, []);

    const { data: assistantMsg, error: assistantErr } = await supabase
      .from('chat_messages')
      .insert({ session_id: chatSession.id, role: 'assistant', content: answer })
      .select('id, role, content, created_at')
      .single();

    if (assistantErr) return NextResponse.json({ error: assistantErr.message }, { status: 500 });

    return NextResponse.json({ session: chatSession, messages: [userMsg, assistantMsg] });
  } catch (err) {
    console.error('[chat-sessions POST] AI pipeline failed:', err);
    // Still return session with user message even if AI fails — surface
    // the error message so the founder can see it instead of "try again"
    const detail = err instanceof Error ? err.message : String(err);
    const errorMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `Failed to generate answer:\n\n\`\`\`\n${detail}\n\`\`\``,
      created_at: new Date().toISOString(),
    };
    return NextResponse.json({ session: chatSession, messages: [userMsg, errorMsg] });
  }
}
