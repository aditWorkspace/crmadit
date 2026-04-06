import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runIncrementalSync, runInitialSync } from '@/lib/gmail/sync';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, gmail_connected, gmail_history_id')
    .eq('gmail_connected', true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!members || members.length === 0) {
    return NextResponse.json({ status: 'no connected members' });
  }

  const results: Record<string, unknown> = {};

  await Promise.allSettled(
    members.map(async (member) => {
      try {
        const result = member.gmail_history_id
          ? await runIncrementalSync(member.id)
          : await runInitialSync(member.id);
        results[member.id] = result;
      } catch (err) {
        results[member.id] = { error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  return NextResponse.json({ status: 'done', results });
}
