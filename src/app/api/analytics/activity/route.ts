import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest, requireSession } from '@/lib/session';
import { getISOWeek, getISOWeekYear, subDays } from 'date-fns';

const INTERACTION_TYPES = ['email', 'call', 'note', 'stage_change'];

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    requireSession(session);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const since = subDays(new Date(), 90).toISOString();

  const { data: interactions, error } = await supabase
    .from('interactions')
    .select('id, type, occurred_at')
    .gte('occurred_at', since)
    .in('type', INTERACTION_TYPES);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // weekKey -> type -> count
  const weekData: Record<string, Record<string, number>> = {};

  for (const row of interactions || []) {
    const d = new Date(row.occurred_at);
    const wk = `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`;
    if (!weekData[wk]) weekData[wk] = {};
    if (!weekData[wk][row.type]) weekData[wk][row.type] = 0;
    weekData[wk][row.type]++;
  }

  // Build sorted week list covering last 90 days
  const weeksSet = new Set<string>();
  for (let d = 89; d >= 0; d -= 7) {
    const date = subDays(new Date(), d);
    weeksSet.add(`${getISOWeekYear(date)}-W${String(getISOWeek(date)).padStart(2, '0')}`);
  }
  for (const wk of Object.keys(weekData)) weeksSet.add(wk);
  const weeks = Array.from(weeksSet).sort();

  const series = INTERACTION_TYPES.map((type) => ({
    type,
    data: weeks.map((wk) => weekData[wk]?.[type] ?? 0),
  }));

  return NextResponse.json({ weeks, series });
}
