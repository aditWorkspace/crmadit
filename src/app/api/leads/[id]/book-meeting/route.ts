import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { createMeetingEvent } from '@/lib/google/calendar';
import { changeStage } from '@/lib/automation/stage-logic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const body = await req.json();
  const { start_time, duration_minutes = 30 } = body;

  if (!start_time) {
    return NextResponse.json({ error: 'start_time required (ISO string)' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Fetch lead + all team members for attendees
  const [leadRes, membersRes] = await Promise.all([
    supabase
      .from('leads')
      .select('id, contact_name, contact_email, company_name, stage, owned_by')
      .eq('id', id)
      .single(),
    supabase
      .from('team_members')
      .select('id, name, email, gmail_connected')
      .is('departed_at', null),
  ]);

  if (!leadRes.data) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
  }

  const lead = leadRes.data;
  const members = membersRes.data || [];

  // Verify the booking member has Google connected
  const bookingMember = members.find(m => m.id === session.id);
  if (!bookingMember?.gmail_connected) {
    return NextResponse.json(
      { error: 'Connect Google in Settings before booking meetings' },
      { status: 400 }
    );
  }

  const startTime = new Date(start_time);
  const endTime = new Date(startTime.getTime() + duration_minutes * 60 * 1000);

  // Include the lead contact + all connected founders as attendees
  const attendeeEmails = [
    lead.contact_email,
    ...members.filter(m => m.gmail_connected).map(m => m.email),
  ].filter((e, i, arr) => e && arr.indexOf(e) === i); // deduplicate

  let createdEvent;
  try {
    createdEvent = await createMeetingEvent(session.id, {
      summary: `Meet with ${lead.contact_name} (${lead.company_name})`,
      description: `Proxi AI discovery call with ${lead.contact_name} at ${lead.company_name}.\n\nBooked via Proxi CRM.`,
      startTime,
      endTime,
      attendeeEmails,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface a clear error if the calendar scope is missing (needs re-auth)
    if (message.includes('insufficientPermissions') || message.includes('forbidden')) {
      return NextResponse.json(
        { error: 'Calendar permission missing — disconnect and reconnect Google in Settings to grant calendar access.' },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: `Calendar error: ${message}` }, { status: 500 });
  }

  // Update lead: set call time, advance stage if still in early stages
  const now = new Date().toISOString();
  await supabase
    .from('leads')
    .update({
      call_scheduled_for: createdEvent.startTime,
      updated_at: now,
    })
    .eq('id', id);

  if (['replied', 'scheduling'].includes(lead.stage)) {
    await changeStage(id, 'scheduled', session.id);
  }

  // Log interaction
  await supabase.from('interactions').insert({
    lead_id: id,
    team_member_id: session.id,
    type: 'other',
    subject: `Meeting booked: ${startTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`,
    body: createdEvent.meetLink
      ? `Google Meet: ${createdEvent.meetLink}\nCalendar: ${createdEvent.eventLink}`
      : `Calendar: ${createdEvent.eventLink}`,
    occurred_at: now,
    metadata: {
      calendar_event_id: createdEvent.eventId,
      event_link: createdEvent.eventLink,
      meet_link: createdEvent.meetLink,
      duration_minutes,
    },
  });

  await supabase.from('activity_log').insert({
    lead_id: id,
    team_member_id: session.id,
    action: 'meeting_booked',
    details: {
      start_time: createdEvent.startTime,
      duration_minutes,
      event_link: createdEvent.eventLink,
      meet_link: createdEvent.meetLink,
    },
  });

  return NextResponse.json({ event: createdEvent });
}
