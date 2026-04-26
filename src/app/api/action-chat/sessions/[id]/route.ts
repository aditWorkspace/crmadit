// GET /api/action-chat/sessions/[id] — load a single session's full
// message history for the chat UI.
// DELETE — drop the session.
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: chat, error: cErr } = await supabase
    .from('action_chat_sessions')
    .select('id, title, updated_at, created_at')
    .eq('id', id)
    .eq('team_member_id', session.id)
    .maybeSingle();
  if (cErr || !chat) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const { data: messages, error: mErr } = await supabase
    .from('action_chat_messages')
    .select('id, role, content, created_at')
    .eq('session_id', id)
    .order('created_at', { ascending: true });
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  return NextResponse.json({ session: chat, messages: messages ?? [] });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('action_chat_sessions')
    .delete()
    .eq('id', id)
    .eq('team_member_id', session.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
