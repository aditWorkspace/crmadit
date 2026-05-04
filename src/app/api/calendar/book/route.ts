// src/app/api/calendar/book/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy, createMeetingEvent } from '@/lib/google/calendar';
import { sanitizeName, sanitizeText, sanitizeEmail } from '@/lib/utils/sanitize';

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
    guestEmails?: string[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name: rawName, email: rawEmail, startTime, durationMinutes, note: rawNote, guestEmails } = body;

  // Sanitize all user inputs to prevent XSS
  const name = sanitizeName(rawName || '');
  const email = sanitizeEmail(rawEmail || '');
  const note = sanitizeText(rawNote || '');

  if (!name || !email || !startTime || ![15, 30].includes(durationMinutes)) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  const cleanGuests: string[] = Array.isArray(guestEmails)
    ? guestEmails
        .map(g => (typeof g === 'string' ? sanitizeEmail(g) : ''))
        .filter(g => g.length > 0 && emailRe.test(g))
    : [];
  if (cleanGuests.length > 20) {
    return NextResponse.json({ error: 'Too many guests (max 20)' }, { status: 400 });
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

  // Must be within booking hours. Weekdays: 9:30am-5pm PT | Weekends: 11am-10pm PT
  const ptHour = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const ptMin = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', minute: '2-digit' })
  );
  const ptDay = new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  const isWeekend = ['Sat', 'Sun'].includes(ptDay);

  let beforeEarliest: boolean;
  let pastCutoff: boolean;
  if (isWeekend) {
    // Weekends: 11am - 10pm PT
    beforeEarliest = ptHour < 11;
    pastCutoff = ptHour >= 22;
  } else {
    // Weekdays: 9:30am - 5pm PT
    beforeEarliest = ptHour < 9 || (ptHour === 9 && ptMin < 30);
    pastCutoff = ptHour >= 17;
  }
  if (beforeEarliest || pastCutoff) {
    const hoursMsg = isWeekend ? 'Sat-Sun 11am-10pm PT' : 'Mon-Fri 9:30am-5pm PT';
    return NextResponse.json({ error: `Slot is outside booking hours (${hoursMsg})` }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Get ACTIVE team members for attendee list (departed founders are
  // never invited to new bookings — see C20 / Srijay departure 2026-05-04).
  const [{ data: allMembers }, { data: connectedMembers }] = await Promise.all([
    supabase.from('team_members').select('id, name, email').is('departed_at', null),
    supabase.from('team_members').select('id, name, email').eq('gmail_connected', true).is('departed_at', null),
  ]);

  if (!connectedMembers?.length) {
    return NextResponse.json({ error: 'No calendar connected — please connect Google in Settings' }, { status: 503 });
  }

  // Re-validate availability at booking time.
  // Require at least 2 confirmed-free members when calendars are reachable.
  // If a member's token is broken/expired we skip them rather than blocking all bookings
  // (the real fix is for that member to reconnect in Settings).
  const results = await Promise.allSettled(
    connectedMembers.map(m => getFreeBusy(m.id, start, end))
  );

  const successfulFetches = results.filter(r => r.status === 'fulfilled').length;

  if (successfulFetches === 0) {
    // Can't verify anyone's availability — fail gracefully
    return NextResponse.json(
      { error: 'Calendar unavailable right now — please try again or contact us directly at hello@proxi.ai' },
      { status: 503 }
    );
  }

  const freeMembers = connectedMembers.filter((_, i) => {
    const r = results[i];
    return r.status === 'fulfilled' && !overlaps(start, end, r.value.busy);
  });

  // Require 2 free if we can verify 2+ calendars, otherwise require all verified ones to be free
  const required = Math.min(2, successfulFetches);
  if (freeMembers.length < required) {
    return NextResponse.json(
      { error: 'Slot no longer available — please pick another time' },
      { status: 409 }
    );
  }

  // Create the event on Adit's calendar so invites come from him.
  // Fall back to any other free member if Adit isn't free.
  freeMembers.sort((a, b) =>
    (a.name.toLowerCase() === 'adit' ? -1 : 0) - (b.name.toLowerCase() === 'adit' ? -1 : 0)
  );

  // Idempotency check: prevent double-click creating duplicate events
  // Key is email + startTime (same person booking same slot = duplicate)
  const idempotencyKey = `${email}_${startTime}`;
  const { data: existingBooking } = await supabase
    .from('booking_idempotency')
    .select('event_id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingBooking?.event_id) {
    // Return cached result instead of creating duplicate
    return NextResponse.json({
      meetLink: null,
      eventLink: null,
      eventId: existingBooking.event_id,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      name,
      email,
      durationMinutes,
      cached: true,
    });
  }

  // Insert idempotency record BEFORE creating event (optimistic lock)
  const { error: lockError } = await supabase
    .from('booking_idempotency')
    .insert({
      idempotency_key: idempotencyKey,
      booking_email: email,
      start_time: start.toISOString(),
    });

  if (lockError?.code === '23505') {
    // Unique constraint violation = concurrent request already locked
    return NextResponse.json(
      { error: 'Booking in progress, please wait...' },
      { status: 409 }
    );
  }

  const founderEmails = (allMembers ?? connectedMembers).map(m => m.email);
  const allEmails = [...new Set([...founderEmails, email, ...cleanGuests])];
  // Build team-name string dynamically from active members so departed
  // founders never appear in the calendar event title or signoff.
  // Sort: Adit first (primary), then alphabetical.
  const founderNames = (allMembers ?? connectedMembers)
    .map(m => m.name)
    .sort((a, b) => (a === 'Adit' ? -1 : b === 'Adit' ? 1 : a.localeCompare(b)));
  const teamLabel =
    founderNames.length === 0 ? 'the team'
    : founderNames.length === 1 ? founderNames[0]
    : founderNames.length === 2 ? `${founderNames[0]} & ${founderNames[1]}`
    : `${founderNames.slice(0, -1).join(', ')} & ${founderNames[founderNames.length - 1]}`;

  const event = await createMeetingEvent(freeMembers[0].id, {
    summary: `Quick chat — ${name} × ${teamLabel}`,
    description: note
      ? `Booking note: ${note}\n\nsource:proxi_crm`
      : 'source:proxi_crm',
    startTime: start,
    endTime: end,
    attendeeEmails: allEmails,
  });

  // Update idempotency record with event ID
  await supabase
    .from('booking_idempotency')
    .update({ event_id: event.eventId })
    .eq('idempotency_key', idempotencyKey);

  // Send confirmation email to booker via Resend
  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    const formattedDate = start.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const formattedTime = start.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const meetSection = event.meetLink
      ? `<p style="margin:16px 0;"><a href="${event.meetLink}" style="display:inline-block;background:#000;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Join Google Meet</a></p>`
      : '';

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Adit & Team <onboarding@resend.dev>',
        to: [email],
        subject: `Confirmed: Quick chat — ${formattedDate}`,
        html: `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
  <h2 style="font-size:20px;font-weight:700;margin-bottom:4px;">You're confirmed!</h2>
  <p style="color:#666;margin-top:0;">Your chat is scheduled. Looking forward to it!</p>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin:20px 0;">
    <p style="margin:0 0 8px;font-size:14px;"><strong>When:</strong> ${formattedDate} at ${formattedTime} PT</p>
    <p style="margin:0 0 8px;font-size:14px;"><strong>Duration:</strong> ${durationMinutes} minutes</p>
    <p style="margin:0;font-size:14px;"><strong>Format:</strong> Google Meet (video)</p>
  </div>

  ${meetSection}

  <p style="margin:16px 0;"><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://pmcrminternal.vercel.app'}/book?rescheduleEventId=${encodeURIComponent(event.eventId)}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name.trim())}" style="color:#b45309;font-size:13px;text-decoration:underline;">Need to reschedule?</a></p>

  <p style="font-size:13px;color:#888;margin-top:24px;">A calendar invite has also been sent to your email. All times are in Pacific Time (PT).</p>
  <p style="font-size:13px;color:#aaa;">— ${teamLabel}</p>
</div>`,
      }),
    }).catch(() => { /* non-fatal — calendar invite still sent */ });

    // Notify all founders about the new booking
    const founderEmailList = (allMembers ?? []).map(m => m.email);
    if (founderEmailList.length > 0) {
      const noteSection = note?.trim()
        ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Notes:</strong> ${note.trim()}</p>`
        : '';

      const founderMeetSection = event.meetLink
        ? `<p style="margin:16px 0;"><a href="${event.meetLink}" style="display:inline-block;background:#111827;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Join Google Meet</a></p>`
        : '';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Adit & Team <onboarding@resend.dev>',
          to: founderEmailList,
          subject: `New call booked: ${name.trim()} on ${formattedDate}`,
          html: `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
  <h2 style="font-size:18px;font-weight:700;margin-bottom:4px;">New call booked</h2>
  <p style="color:#666;margin-top:0;">Someone just scheduled a call via the booking page.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin:20px 0;">
    <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name.trim()}</p>
    <p style="margin:0 0 8px;font-size:14px;"><strong>Email:</strong> ${email}</p>
    <p style="margin:0 0 8px;font-size:14px;"><strong>When:</strong> ${formattedDate} at ${formattedTime} PT</p>
    <p style="margin:0 0 8px;font-size:14px;"><strong>Duration:</strong> ${durationMinutes} minutes</p>
    ${noteSection}
  </div>

  ${founderMeetSection}

  <p style="font-size:13px;color:#aaa;">— ${teamLabel}</p>
</div>`,
        }),
      }).catch(() => { /* non-fatal */ });
    }
  }

  return NextResponse.json({
    meetLink: event.meetLink,
    eventLink: event.eventLink,
    eventId: event.eventId,
    startTime: event.startTime,
    endTime: end.toISOString(),
    name: name.trim(),
    email: email.trim(),
    durationMinutes,
  });
}
