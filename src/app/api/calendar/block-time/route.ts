import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getCalendarClientForMember } from '@/lib/google/calendar';

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

  if (allDay) {
    // All-day event: use `date` format (not dateTime)
    // Google Calendar all-day events use exclusive end date, so block a single day
    // by setting end = day + 1
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    requestBody.start = { date: date };
    requestBody.end = { date: endDate.toISOString().split('T')[0] };
  } else {
    requestBody.start = { dateTime: start, timeZone: 'America/Los_Angeles' };
    requestBody.end = { dateTime: end, timeZone: 'America/Los_Angeles' };
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody,
  });

  return NextResponse.json({
    eventId: res.data.id,
    htmlLink: res.data.htmlLink,
  });
}
