// POST /api/action-chat/cancel — drop a pending mutation without
// executing it.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { cancelPending } from '@/lib/actions/dispatcher';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json();
  const { pending_id } = body as { pending_id?: string };
  if (!pending_id) return NextResponse.json({ error: 'pending_id required' }, { status: 400 });

  const r = await cancelPending(pending_id, session.id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // Add a tiny chat note so the user can see it was cancelled.
  const supabase = createAdminClient();
  const { data: pending } = await supabase
    .from('action_chat_pending')
    .select('session_id, tool_name')
    .eq('id', pending_id)
    .single();
  if (pending) {
    await supabase.from('action_chat_messages').insert({
      session_id: pending.session_id,
      role: 'tool',
      content: {
        tool_call_id: pending_id,
        tool_name: pending.tool_name,
        outcome: { kind: 'mutation_cancelled', tool_call_id: pending_id, tool_name: pending.tool_name },
      },
    });
  }
  return NextResponse.json({ ok: true });
}
