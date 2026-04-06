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
    timezone?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, startTime, durationMinutes, note } = body;

  if (!name?.trim() || !email?.trim() || !startTime || ![15, 30].includes(durationMinutes)) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  if (isNaN(start.getTime())) {
    return NextResponse.json({ error: 'Invalid startTime' }, { status: 400 });
  }

  // Must be at least 2 hours from now
  if (start.getTime() < Date.now() + 2 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Please book at least 2 hours in advance' }, { status: 400 });
  }

  // Must be within 9am–5pm PT on a weekday
  const ptHour = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const ptDay = new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  if (['Sat', 'Sun'].includes(ptDay) || ptHour < 9 || ptHour >= 17) {
    return NextResponse.json({ error: 'Slot is outside booking hours (Mon–Fri, 9am–5pm PT)' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return NextResponse.json({ error: 'No team members available' }, { status: 503 });
  }

  // Re-validate: check that ≥2 members are still free
  const results = await Promise.allSettled(
    members.map(m => getFreeBusy(m.id, start, end))
  );

  const freeMembers = members.filter((_, i) => {
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
  // All founders + prospect are added as attendees — Google sends invites automatically.
  const allEmails = [...members.map(m => m.email), email];

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
