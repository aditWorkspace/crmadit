import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, gmail_connected, last_gmail_sync, gmail_history_id')
    .eq('id', session.id)
    .single();

  if (error || !member) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    connected: member.gmail_connected,
    last_sync: member.last_gmail_sync,
    has_history: !!member.gmail_history_id,
  });
}
