// src/app/api/calendar/availability/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy, getEventsInRange } from '@/lib/google/calendar';

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
    .select('id, name, email')
    .eq('gmail_connected', true);

  // Fetch freebusy for all connected members in parallel.
  // IMPORTANT: treat failed fetches as BUSY (fail-closed).
  // If we can't confirm someone is free, we must not allow bookings during that time.
  const busyByMember: Record<string, { start: string; end: string }[]> = {};
  const fetchedMemberIds = new Set<string>();
  let failedCount = 0;

  if (members?.length) {
    const results = await Promise.allSettled(
      members.map(m => getFreeBusy(m.id, timeMin, timeMax))
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        busyByMember[members[i].id] = r.value.busy;
        fetchedMemberIds.add(members[i].id);
      } else {
        failedCount++;
        // Do NOT add to busyByMember — absence = treated as fully busy below
      }
    }
  }

  // Build 30-min slots across the full range.
  // busyCount = members who are confirmed busy OR whose status is unknown (failed fetch).
  // Slot is bookable when busyCount <= 1 (i.e. ≥2 confirmed free).
  const slots: { start: string; end: string; busyCount: number }[] = [];
  const cursor = new Date(timeMin);
  while (cursor < timeMax) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
    const busyCount = (members ?? []).filter(m => {
      // Member whose freebusy fetch failed → treat as busy (fail-closed)
      if (!fetchedMemberIds.has(m.id)) return true;
      // Member with confirmed freebusy → check if they overlap this slot
      return overlaps(cursor, slotEnd, busyByMember[m.id]);
    }).length;
    slots.push({
      start: cursor.toISOString(),
      end: slotEnd.toISOString(),
      busyCount,
    });
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  // Fetch events for the requesting member to classify Proxi vs personal busy time
  const requestingMemberId = req.headers.get('x-team-member-id');
  interface ClassifiedEvent {
    id: string;
    summary: string;
    start: string;
    end: string;
    isProxi: boolean;
  }
  let calendarEvents: ClassifiedEvent[] = [];

  if (requestingMemberId) {
    try {
      const rawEvents = await getEventsInRange(requestingMemberId, timeMin, timeMax);
      const teamEmailSet = new Set((members ?? []).map(m => (m.email || '').toLowerCase()));

      calendarEvents = rawEvents
        .filter(ev => !ev.isAllDay && ev.start)
        .map(ev => {
          const attendeeSet = new Set(ev.attendeeEmails);
          // Proxi event: every connected team member is an attendee
          const isProxi = teamEmailSet.size > 0 &&
            [...teamEmailSet].every(email => attendeeSet.has(email));
          return { id: ev.id, summary: ev.summary, start: ev.start, end: ev.end, isProxi };
        });
    } catch {
      // Non-fatal: show heatmap only without event overlay
    }
  }

  return NextResponse.json({
    slots,
    events: calendarEvents,
    connectedCount: members?.length ?? 0,
    connectedSuccessfully: (members?.length ?? 0) - failedCount,
    failedCount,
    timezone: 'America/Los_Angeles',
  });
}
