// src/app/api/calendar/book/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy, createMeetingEvent } from '@/lib/google/calendar';

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  busy: { start: string; end: string }[]
): boolean {
  return busy.some(b => new Date(b.start) < slotEnd && new Date(b.end) > slotStart);
}

export async function POST(req: NextRequest) {
  let body: {
    name: string;
    email: string;
    startTime: string;
    durationMinutes: number;
    note?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, startTime, durationMinutes, note } = body;

  if (!name?.trim() || !email?.trim() || !startTime || ![20, 30].includes(durationMinutes)) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  const start = new Date(startTime);
  if (isNaN(start.getTime())) {
    return NextResponse.json({ error: 'Invalid startTime' }, { status: 400 });
  }
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  // Must be at least 2 hours from now
  if (start.getTime() < Date.now() + 2 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Please book at least 2 hours in advance' }, { status: 400 });
  }

  // Must be within 9am–5pm PT on a weekday
  // Slots must start within 9am–5pm PT (ptHour >= 17 rejects 5pm starts — last valid start is 4:30pm)
  const ptHour = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const ptDay = new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  if (['Sat', 'Sun'].includes(ptDay) || ptHour < 9 || ptHour >= 17) {
    return NextResponse.json({ error: 'Slot is outside booking hours (Mon–Fri, 9am–5pm PT)' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Get ALL team members for attendee list, but only connected ones for freebusy
  const [{ data: allMembers }, { data: connectedMembers }] = await Promise.all([
    supabase.from('team_members').select('id, name, email'),
    supabase.from('team_members').select('id, name, email').eq('gmail_connected', true),
  ]);

  if (!connectedMembers?.length) {
    return NextResponse.json({ error: 'No calendar connected — please connect Google in Settings' }, { status: 503 });
  }

  // Re-validate: check that at least 1 connected member is still free
  const results = await Promise.allSettled(
    connectedMembers.map(m => getFreeBusy(m.id, start, end))
  );

  const freeMembers = connectedMembers.filter((_, i) => {
    const r = results[i];
    return r.status === 'fulfilled' && !overlaps(start, end, r.value.busy);
  });

  if (freeMembers.length < 2) {
    return NextResponse.json(
      { error: 'Slot no longer available — please pick another time' },
      { status: 409 }
    );
  }

  // Create the event on the first free member's calendar.
  // Always invite ALL founders (even those not yet OAuth-connected) + the prospect.
  const founderEmails = (allMembers ?? connectedMembers).map(m => m.email);
  const allEmails = [...new Set([...founderEmails, email])];

  const event = await createMeetingEvent(freeMembers[0].id, {
    summary: `Quick call — ${name.trim()} × Proxi AI`,
    description: note?.trim()
      ? `Booking note: ${note.trim()}\n\nsource:proxi_crm`
      : 'source:proxi_crm',
    startTime: start,
    endTime: end,
    attendeeEmails: allEmails,
  });

  return NextResponse.json({
    meetLink: event.meetLink,
    eventLink: event.eventLink,
    startTime: event.startTime,
    endTime: end.toISOString(),
    name: name.trim(),
    durationMinutes,
  });
}
