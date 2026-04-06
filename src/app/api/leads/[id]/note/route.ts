import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { body, pinned } = await req.json();
  if (!body?.trim()) return NextResponse.json({ error: 'Note body required' }, { status: 400 });

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Create interaction
  const { data: interaction, error } = await supabase
    .from('interactions')
    .insert({
      lead_id: id,
      team_member_id: session.id,
      type: 'note',
      body: body.trim(),
      occurred_at: now,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If pinned, update lead's pinned_note
  if (pinned) {
    await supabase.from('leads').update({ pinned_note: body.trim() }).eq('id', id);
  }

  // Log activity
  await supabase.from('activity_log').insert({
    lead_id: id,
    team_member_id: session.id,
    action: 'note_added',
    details: { preview: body.substring(0, 100), pinned: !!pinned },
  });

  return NextResponse.json({ interaction });
}
