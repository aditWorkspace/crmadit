// POST /api/action-chat/confirm — confirm a previously-previewed mutation.
// Body: { pending_id }. Looks up the pending row, runs the tool's execute(),
// stores a tool result message in the chat, and returns the result.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { confirmPending } from '@/lib/actions/dispatcher';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json();
  const { pending_id } = body as { pending_id?: string };
  if (!pending_id) return NextResponse.json({ error: 'pending_id required' }, { status: 400 });

  const r = await confirmPending(pending_id, session.id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // Look up the pending row to get session_id + tool_name for chat history.
  const supabase = createAdminClient();
  const { data: pending } = await supabase
    .from('action_chat_pending')
    .select('session_id, tool_name')
    .eq('id', pending_id)
    .single();

  if (pending) {
    // Persist the result as a tool message so the chat shows it inline.
    await supabase.from('action_chat_messages').insert({
      session_id: pending.session_id,
      role: 'tool',
      content: {
        tool_call_id: pending_id,
        tool_name: pending.tool_name,
        outcome: { kind: 'mutation_result', tool_call_id: pending_id, tool_name: pending.tool_name, data: r.result },
      },
    });
    await supabase
      .from('action_chat_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', pending.session_id);
  }

  return NextResponse.json({ ok: true, result: r.result });
}
