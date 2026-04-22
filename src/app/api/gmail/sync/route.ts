import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { runInitialSync, runIncrementalSync } from '@/lib/gmail/sync';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Check gmail is connected and get history_id
  const { data: member } = await supabase
    .from('team_members')
    .select('id, gmail_connected, gmail_history_id')
    .eq('id', session.id)
    .single();

  if (!member?.gmail_connected) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 });
  }

  // Support ?full=true to force a full resync
  const url = new URL(req.url);
  const forceFull = url.searchParams.get('full') === 'true';

  const result = (member.gmail_history_id && !forceFull)
    ? await runIncrementalSync(session.id)
    : await runInitialSync(session.id);

  return NextResponse.json({ success: true, ...result });
}
