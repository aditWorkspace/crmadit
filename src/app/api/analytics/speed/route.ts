import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest, requireSession } from '@/lib/session';
import { getISOWeek, getISOWeekYear, subDays } from 'date-fns';

interface InteractionRow {
  id: string;
  lead_id: string;
  team_member_id: string;
  occurred_at: string;
  type: string;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    requireSession(session);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const since = subDays(new Date(), 90).toISOString();

  const [{ data: interactions, error: intError }, { data: members, error: memError }] =
    await Promise.all([
      supabase
        .from('interactions')
        .select('id, lead_id, team_member_id, occurred_at, type')
        .gte('occurred_at', since)
        .in('type', ['email_inbound', 'email_outbound'])
        .order('lead_id')
        .order('occurred_at', { ascending: true }),
      supabase.from('team_members').select('id, name'),
    ]);

  if (intError || memError) {
    return NextResponse.json({ error: intError?.message || memError?.message }, { status: 500 });
  }

  // For each outbound interaction, find preceding inbound for same lead, compute hours gap
  const grouped: Record<string, InteractionRow[]> = {};
  for (const row of interactions || []) {
    if (!grouped[row.lead_id]) grouped[row.lead_id] = [];
    grouped[row.lead_id].push(row as InteractionRow);
  }

  // weekKey -> memberId -> hours[]
  const weekData: Record<string, Record<string, number[]>> = {};

  for (const leadRows of Object.values(grouped)) {
    for (let i = 1; i < leadRows.length; i++) {
      const curr = leadRows[i];
      const prev = leadRows[i - 1];
      if (curr.type === 'email_outbound' && prev.type === 'email_inbound') {
        const outDate = new Date(curr.occurred_at);
        const inDate = new Date(prev.occurred_at);
        const hours = (outDate.getTime() - inDate.getTime()) / (1000 * 60 * 60);
        if (hours < 0 || hours > 168) continue; // ignore implausible gaps >1 week
        const weekKey = `${getISOWeekYear(outDate)}-W${String(getISOWeek(outDate)).padStart(2, '0')}`;
        if (!weekData[weekKey]) weekData[weekKey] = {};
        if (!weekData[weekKey][curr.team_member_id]) weekData[weekKey][curr.team_member_id] = [];
        weekData[weekKey][curr.team_member_id].push(hours);
      }
    }
  }

  // Build sorted week list from last 90 days
  const weeksSet = new Set<string>();
  for (let d = 89; d >= 0; d -= 7) {
    const date = subDays(new Date(), d);
    const wk = `${getISOWeekYear(date)}-W${String(getISOWeek(date)).padStart(2, '0')}`;
    weeksSet.add(wk);
  }
  // Also add any weeks found in data
  for (const wk of Object.keys(weekData)) weeksSet.add(wk);
  const weeks = Array.from(weeksSet).sort();

  const series = (members || []).map((m) => ({
    name: m.name,
    data: weeks.map((wk) => {
      const hrs = weekData[wk]?.[m.id];
      if (!hrs || hrs.length === 0) return null;
      return Math.round((hrs.reduce((a, b) => a + b, 0) / hrs.length) * 10) / 10;
    }),
  }));

  return NextResponse.json({ weeks, series });
}
