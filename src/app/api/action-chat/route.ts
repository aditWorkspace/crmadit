// POST /api/action-chat — send a user message; orchestrator runs the
// tool-calling loop and returns the resulting messages + any pending
// confirmation cards. If no session_id is supplied a fresh session is
// created and its id returned.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { runActionChat } from '@/lib/ai/action-chat-orchestrator';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { message, session_id } = body as { message?: string; session_id?: string };
  if (!message?.trim()) return NextResponse.json({ error: 'message is required' }, { status: 400 });

  const supabase = createAdminClient();

  // Create the session lazily if one wasn't passed in.
  let sessionId = session_id;
  let createdSession = null;
  if (!sessionId) {
    const title = message.length > 60 ? message.slice(0, 57) + '…' : message;
    const { data, error } = await supabase
      .from('action_chat_sessions')
      .insert({ team_member_id: session.id, title })
      .select('id, title, updated_at, created_at')
      .single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'failed to create session' }, { status: 500 });
    sessionId = data.id;
    createdSession = data;
  } else {
    // Verify the caller owns the session.
    const { data, error } = await supabase
      .from('action_chat_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('team_member_id', session.id)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }

  // Pull prior history (cap at 20 messages so context stays sane).
  const { data: priorRows } = await supabase
    .from('action_chat_messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  const history = (priorRows || []).slice(-20).map(r => normalizeHistoryRow(r));

  // Persist the new user message. Capture this run's start timestamp BEFORE
  // the orchestrator starts so we can later fetch every message it created
  // (was: gte 5s window — dropped tool messages from longer runs).
  const runStartedAt = new Date().toISOString();
  const { data: userRow, error: userErr } = await supabase
    .from('action_chat_messages')
    .insert({
      session_id: sessionId,
      role: 'user',
      content: { text: message },
    })
    .select('id')
    .single();
  if (userErr || !userRow) return NextResponse.json({ error: userErr?.message ?? 'failed to save user message' }, { status: 500 });

  let runResult;
  try {
    runResult = await runActionChat({
      session_id: sessionId!,
      user_message_id: userRow.id,
      history,
      current_user_text: message,
      ctx: { teamMemberId: session.id, teamMemberName: session.name ?? '' },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[action-chat] runActionChat failed:', detail);
    const { data: errRow } = await supabase
      .from('action_chat_messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content: { text: `Failed to run action chat: ${detail}` },
      })
      .select('id, role, content, created_at')
      .single();
    return NextResponse.json({
      session_id: sessionId,
      created_session: createdSession,
      messages: errRow ? [errRow] : [],
      error: detail,
    });
  }

  // Bump session updated_at + (if first message) the session title.
  await supabase
    .from('action_chat_sessions')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', sessionId);

  // Re-fetch the persisted messages we just created so the client renders
  // exactly what the DB has (including ids).
  const { data: newMessages } = await supabase
    .from('action_chat_messages')
    .select('id, role, content, created_at')
    .eq('session_id', sessionId)
    .gte('created_at', runStartedAt)
    .order('created_at', { ascending: true });

  return NextResponse.json({
    session_id: sessionId,
    created_session: createdSession,
    final_text: runResult.final_text,
    messages: newMessages ?? [],
  });
}

interface RowContent {
  text?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  tool_name?: string;
  outcome?: { raw_for_llm?: string };
}

function normalizeHistoryRow(r: { role: string; content: unknown }) {
  const c = r.content as RowContent;
  if (r.role === 'user' || r.role === 'system') {
    return { role: r.role as 'user' | 'system', content: c?.text ?? '' };
  }
  if (r.role === 'assistant') {
    return { role: 'assistant' as const, content: c?.text ?? '', tool_calls: c?.tool_calls };
  }
  // tool
  return {
    role: 'tool' as const,
    content: c?.outcome?.raw_for_llm ?? JSON.stringify(c?.outcome ?? {}),
    tool_call_id: c?.tool_call_id,
  };
}

// GET /api/action-chat — list this user's sessions.
export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('action_chat_sessions')
    .select('id, title, updated_at, created_at')
    .eq('team_member_id', session.id)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}
