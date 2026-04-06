import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest, requireSession } from '@/lib/session';
import { ACTIVE_STAGES, STAGE_LABELS } from '@/lib/constants';

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    requireSession(session);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, stage')
    .eq('is_archived', false);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts: Record<string, number> = {};
  for (const stage of ACTIVE_STAGES) counts[stage] = 0;
  for (const lead of leads || []) {
    if (counts[lead.stage] !== undefined) counts[lead.stage]++;
  }

  const result = ACTIVE_STAGES.map((stage, i) => {
    const count = counts[stage];
    const prevCount = i > 0 ? counts[ACTIVE_STAGES[i - 1]] : null;
    const conversion_rate =
      prevCount !== null && prevCount > 0
        ? Math.round((count / prevCount) * 100)
        : null;
    return {
      stage,
      label: STAGE_LABELS[stage as keyof typeof STAGE_LABELS],
      count,
      conversion_rate,
    };
  });

  return NextResponse.json(result);
}
