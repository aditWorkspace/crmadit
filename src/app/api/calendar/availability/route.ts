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
  const bookingOnly = req.nextUrl.searchParams.get('bookingOnly') === 'true';
  const slots: { start: string; end: string; busyCount: number }[] = [];
  const nowMs = Date.now();
  const cursor = new Date(timeMin);
  while (cursor < timeMax) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);

    // When bookingOnly: skip non-bookable slots entirely (nights, weekends,
    // past, outside 9:30am-5pm PT).
    if (bookingOnly) {
      const ptDay = cursor.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
      if (ptDay === 'Sat' || ptDay === 'Sun') { cursor.setTime(cursor.getTime() + 30 * 60 * 1000); continue; }
      if (cursor.getTime() < nowMs) { cursor.setTime(cursor.getTime() + 30 * 60 * 1000); continue; }
      const ptH = parseInt(cursor.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }));
      const ptM = parseInt(cursor.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', minute: '2-digit' }));
      const afterEarliest = ptH > 9 || (ptH === 9 && ptM >= 30);
      const beforeLatest = ptH < 17;
      if (!afterEarliest || !beforeLatest) { cursor.setTime(cursor.getTime() + 30 * 60 * 1000); continue; }
    }

    const busyCount = (members ?? []).filter(m => {
      // Member whose freebusy fetch failed → treat as busy (fail-closed)
      if (!fetchedMemberIds.has(m.id)) return true;
      // Member with confirmed freebusy → check if they overlap this slot
      return overlaps(cursor, slotEnd, busyByMember[m.id]);
    }).length;

    // When bookingOnly: also skip slots where not enough people are free
    if (bookingOnly && busyCount > 1) {
      cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
      continue;
    }

    slots.push({
      start: cursor.toISOString(),
      end: slotEnd.toISOString(),
      busyCount,
    });
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  // Fetch events for the requesting member to classify and enrich
  const requestingMemberId = req.headers.get('x-team-member-id');
  interface ClassifiedEvent {
    id: string;
    summary: string;
    start: string;
    end: string;
    isProxi: boolean;
    meetLink: string | null;
    htmlLink: string | null;
    attendees: string[];
    leadId: string | null;
    leadName: string | null;
    meetingType: 'discovery' | 'followup' | 'internal' | 'personal';
  }
  let calendarEvents: ClassifiedEvent[] = [];

  if (requestingMemberId) {
    try {
      const rawEvents = await getEventsInRange(requestingMemberId, timeMin, timeMax);
      const teamEmailSet = new Set((members ?? []).map(m => (m.email || '').toLowerCase()));

      // Collect all non-team attendee emails to batch-match against leads
      const externalEmails = new Set<string>();
      for (const ev of rawEvents) {
        for (const email of ev.attendeeEmails) {
          if (!teamEmailSet.has(email)) externalEmails.add(email);
        }
      }

      // Batch lookup: find leads matching any external attendee email
      const leadsByEmail: Record<string, { id: string; contact_name: string; stage: string }> = {};
      if (externalEmails.size > 0) {
        const { data: matchedLeads } = await supabase
          .from('leads')
          .select('id, contact_name, contact_email, stage')
          .in('contact_email', [...externalEmails])
          .eq('is_archived', false);
        for (const lead of matchedLeads ?? []) {
          leadsByEmail[lead.contact_email.toLowerCase()] = {
            id: lead.id,
            contact_name: lead.contact_name,
            stage: lead.stage,
          };
        }
      }

      // Stages that indicate a first meeting hasn't happened yet
      const discoveryStages = new Set(['replied', 'scheduling', 'scheduled']);

      calendarEvents = rawEvents
        .filter(ev => !ev.isAllDay && ev.start)
        .map(ev => {
          const attendeeSet = new Set(ev.attendeeEmails);
          const externalAttendees = ev.attendeeEmails.filter(e => !teamEmailSet.has(e));
          const isAllTeam = teamEmailSet.size > 0 &&
            [...teamEmailSet].every(email => attendeeSet.has(email));

          // Match lead from attendees
          let matchedLead: { id: string; contact_name: string; stage: string } | null = null;
          for (const email of externalAttendees) {
            if (leadsByEmail[email]) { matchedLead = leadsByEmail[email]; break; }
          }

          // Classify meeting type
          let meetingType: ClassifiedEvent['meetingType'] = 'personal';
          if (externalAttendees.length === 0 && attendeeSet.size > 1) {
            meetingType = 'internal';
          } else if (matchedLead) {
            meetingType = discoveryStages.has(matchedLead.stage) ? 'discovery' : 'followup';
          } else if (isAllTeam && externalAttendees.length > 0) {
            meetingType = 'discovery'; // external attendee but no lead match — assume discovery
          }

          return {
            id: ev.id,
            summary: ev.summary,
            start: ev.start,
            end: ev.end,
            isProxi: isAllTeam,
            meetLink: ev.meetLink,
            htmlLink: ev.htmlLink,
            attendees: ev.attendeeEmails,
            leadId: matchedLead?.id ?? null,
            leadName: matchedLead?.contact_name ?? null,
            meetingType,
          };
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
