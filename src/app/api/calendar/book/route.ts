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

  // Must be within 9am–2:00pm PT on a weekday (last slot starts at 2:00pm, ends at 2:30pm max)
  const ptHour = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const ptMin = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', minute: '2-digit' })
  );
  const ptDay = new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  const pastCutoff = ptHour > 14 || (ptHour === 14 && ptMin >= 30);
  if (['Sat', 'Sun'].includes(ptDay) || ptHour < 9 || pastCutoff) {
    return NextResponse.json({ error: 'Slot is outside booking hours (Mon–Fri, 9am–2pm PT)' }, { status: 400 });
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
        from: 'Proxi AI <onboarding@resend.dev>',
        to: [email],
        subject: `Confirmed: Quick call with Proxi AI — ${formattedDate}`,
        html: `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
  <h2 style="font-size:20px;font-weight:700;margin-bottom:4px;">You're confirmed!</h2>
  <p style="color:#666;margin-top:0;">Your call with Proxi AI is scheduled.</p>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin:20px 0;">
    <p style="margin:0 0 8px;font-size:14px;"><strong>When:</strong> ${formattedDate} at ${formattedTime} PT</p>
    <p style="margin:0 0 8px;font-size:14px;"><strong>Duration:</strong> ${durationMinutes} minutes</p>
    <p style="margin:0;font-size:14px;"><strong>Format:</strong> Google Meet (video)</p>
  </div>

  ${meetSection}

  <p style="font-size:13px;color:#888;margin-top:24px;">A calendar invite has also been sent to your email. All times are in Pacific Time (PT).</p>
  <p style="font-size:13px;color:#aaa;">— The Proxi AI team</p>
</div>`,
      }),
    }).catch(() => { /* non-fatal — calendar invite still sent */ });
  }

  return NextResponse.json({
    meetLink: event.meetLink,
    eventLink: event.eventLink,
    startTime: event.startTime,
    endTime: end.toISOString(),
    name: name.trim(),
    durationMinutes,
  });
}
