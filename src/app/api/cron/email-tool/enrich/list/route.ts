// GET /api/cron/email-tool/enrich/list — admin only.
//
// Returns the last 50 enrich_jobs with all counters + pool deltas.
// Joins team_members to surface the creator's name for the
// history list ("by Adit", "by Asim").
export const maxDuration = 10;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('enrich_jobs')
    .select('id, created_at, status, mode, file_name, total_rows, processed, kept, dropped, bec_calls, icypeas_calls, cost_usd, inserted_to_pool, already_in_pool, already_blacklisted, pool_size_before, pool_size_after, started_at, completed_at, last_error, team_members(name)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: 'lookup_failed', detail: error.message }, { status: 500 });

  const jobs = ((data ?? []) as Array<Record<string, unknown> & { team_members?: { name?: string } | null }>).map(j => ({
    ...j,
    created_by_name: (j.team_members && typeof j.team_members === 'object' && 'name' in j.team_members ? j.team_members.name : null) ?? null,
    team_members: undefined,
  }));
  return NextResponse.json({ jobs });
}
