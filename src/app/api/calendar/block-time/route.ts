import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getCalendarClientForMember } from '@/lib/google/calendar';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { start, end, summary } = await req.json();
  if (!start || !end) {
    return NextResponse.json({ error: 'start and end are required' }, { status: 400 });
  }

  const calendar = await getCalendarClientForMember(session.id);

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: summary || 'Blocked',
      start: { dateTime: start, timeZone: 'America/Los_Angeles' },
      end: { dateTime: end, timeZone: 'America/Los_Angeles' },
      transparency: 'opaque',
    },
  });

  return NextResponse.json({
    eventId: res.data.id,
    htmlLink: res.data.htmlLink,
  });
}
