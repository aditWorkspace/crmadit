import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getCalendarClientForMember } from '@/lib/google/calendar';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { start, end, summary, allDay, date } = await req.json();

  // All-day block: requires `date` (YYYY-MM-DD string)
  // Time-range block: requires `start` and `end` (ISO strings)
  if (!allDay && (!start || !end)) {
    return NextResponse.json({ error: 'start and end are required for time-range blocks' }, { status: 400 });
  }
  if (allDay && !date) {
    return NextResponse.json({ error: 'date is required for all-day blocks' }, { status: 400 });
  }

  const calendar = await getCalendarClientForMember(session.id);

  const requestBody: Record<string, unknown> = {
    summary: summary || 'Blocked',
    transparency: 'opaque',
  };

  // Determine the date being blocked for cache invalidation
  let blockedDate: Date;
  if (allDay) {
    blockedDate = new Date(date);
    const endDate = new Date(blockedDate);
    endDate.setDate(endDate.getDate() + 1);
    requestBody.start = { date: date };
    requestBody.end = { date: endDate.toISOString().split('T')[0] };
  } else {
    blockedDate = new Date(start);
    requestBody.start = { dateTime: start, timeZone: 'America/Los_Angeles' };
    requestBody.end = { dateTime: end, timeZone: 'America/Los_Angeles' };
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody,
  });

  // Invalidate the availability cache for this member so the booking page
  // immediately reflects the blocked time. We delete all cache entries for
  // this member - they'll be re-fetched fresh on next availability request.
  const supabase = createAdminClient();
  await supabase
    .from('availability_cache')
    .delete()
    .eq('member_id', session.id);

  return NextResponse.json({
    eventId: res.data.id,
    htmlLink: res.data.htmlLink,
  });
}
