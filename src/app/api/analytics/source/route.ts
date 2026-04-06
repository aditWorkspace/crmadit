import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest, requireSession } from '@/lib/session';
import { STAGE_ORDER } from '@/lib/constants';

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    requireSession(session);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  const [{ data: leads, error: leadsError }, { data: members, error: membersError }] =
    await Promise.all([
      supabase
        .from('leads')
        .select('stage, owned_by')
        .eq('is_archived', false),
      supabase.from('team_members').select('id, name'),
    ]);

  if (leadsError || membersError) {
    return NextResponse.json({ error: leadsError?.message || membersError?.message }, { status: 500 });
  }

  const byMember: Record<string, number[]> = {};
  for (const lead of leads || []) {
    if (!byMember[lead.owned_by]) byMember[lead.owned_by] = [];
    const score = STAGE_ORDER.indexOf(lead.stage as (typeof STAGE_ORDER)[number]);
    byMember[lead.owned_by].push(score >= 0 ? score : 0);
  }

  const result = (members || []).map((m) => {
    const scores = byMember[m.id] ?? [];
    return {
      name: m.name,
      avg_stage_score:
        scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : 0,
      lead_count: scores.length,
    };
  });

  return NextResponse.json(result);
}
