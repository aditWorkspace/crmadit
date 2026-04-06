// src/app/api/calendar/availability/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy } from '@/lib/google/calendar';

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  busy: { start: string; end: string }[]
): boolean {
  return busy.some(b => new Date(b.start) < slotEnd && new Date(b.end) > slotStart);
}

export async function GET(req: NextRequest) {
  // No auth check — this route is intentionally public.
  // Used by both the internal /calendar page (with session) and the public /book page (no session).

  const start = req.nextUrl.searchParams.get('start');
  const end = req.nextUrl.searchParams.get('end');
  if (!start || !end) {
    return NextResponse.json({ error: 'Missing start or end param' }, { status: 400 });
  }

  const timeMin = new Date(start);
  const timeMax = new Date(end);
  if (isNaN(timeMin.getTime()) || isNaN(timeMax.getTime())) {
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
  }

  if (timeMin >= timeMax) {
    return NextResponse.json({ error: 'start must be before end' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return NextResponse.json({ slots: [], connectedCount: 0, timezone: 'America/Los_Angeles' });
  }

  // Fetch freebusy for all members in parallel; skip failures gracefully
  const results = await Promise.allSettled(
    members.map(m => getFreeBusy(m.id, timeMin, timeMax))
  );

  const busyByMember: Record<string, { start: string; end: string }[]> = {};
  const failedCount = results.reduce((acc, r, i) => {
    if (r.status === 'fulfilled') {
      busyByMember[members[i].id] = r.value.busy;
      return acc;
    }
    return acc + 1;
  }, 0);

  // Build 30-min slots across the full range
  const slots: { start: string; end: string; busyCount: number }[] = [];
  const cursor = new Date(timeMin);
  while (cursor < timeMax) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
    const busyCount = members.filter(
      m => busyByMember[m.id] && overlaps(cursor, slotEnd, busyByMember[m.id])
    ).length;
    slots.push({
      start: cursor.toISOString(),
      end: slotEnd.toISOString(),
      busyCount,
    });
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  return NextResponse.json({
    slots,
    connectedCount: members.length,
    connectedSuccessfully: members.length - failedCount,
    timezone: 'America/Los_Angeles',
  });
}
