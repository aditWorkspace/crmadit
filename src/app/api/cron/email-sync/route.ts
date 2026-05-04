// 300s — steady-state runs are seconds, but any catch-up after an outage can
// take minutes (measured 4.9 min catch-up after a 5-day sync gap). Keeping the
// ceiling at Vercel's maximum ensures post-outage runs actually finish and
// write back the fresh gmail_history_id instead of looping on the same backlog.
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runIncrementalSync, runInitialSync } from '@/lib/gmail/sync';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, gmail_connected, gmail_history_id')
    .eq('gmail_connected', true)
    .is('departed_at', null);

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

export const GET = handler;
export const POST = handler;
