import { google } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken, encryptToken, refreshAccessToken } from '@/lib/gmail/auth';

export interface MeetingEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  attendeeEmails: string[];
  description?: string;
}

export interface CreatedEvent {
  eventId: string;
  eventLink: string;
  meetLink: string | null;
  startTime: string;
}

/**
 * Get an authenticated Google Calendar client for a team member.
 * Reuses the same encrypted OAuth tokens as the Gmail client — same auth object,
 * different Google API service.
 */
export async function getCalendarClientForMember(teamMemberId: string) {
  const supabase = createAdminClient();

  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, gmail_access_token, gmail_refresh_token, gmail_token_expiry, gmail_connected')
    .eq('id', teamMemberId)
    .single();

  if (error || !member) throw new Error(`Team member not found: ${teamMemberId}`);
  if (!member.gmail_connected) throw new Error(`Google not connected for member: ${teamMemberId}`);
  if (!member.gmail_access_token || !member.gmail_refresh_token) {
    throw new Error(`Google tokens missing for member: ${teamMemberId}`);
  }

  let accessToken: string;
  const expiry = member.gmail_token_expiry ? new Date(member.gmail_token_expiry).getTime() : 0;
  const isExpired = Date.now() >= expiry - 60_000;

  if (isExpired) {
    const refreshed = await refreshAccessToken(member.gmail_refresh_token);
    accessToken = refreshed.access_token;

    const encryptedAccess = encryptToken(refreshed.access_token);
    const updates: Record<string, string | null> = {
      gmail_access_token: encryptedAccess,
    };
    if (refreshed.refresh_token) {
      updates.gmail_refresh_token = encryptToken(refreshed.refresh_token);
    }
    if (refreshed.expiry_date) {
      updates.gmail_token_expiry = new Date(refreshed.expiry_date).toISOString();
    }
    await supabase.from('team_members').update(updates).eq('id', teamMemberId);
  } else {
    accessToken = decryptToken(member.gmail_access_token);
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ access_token: accessToken });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Create a Google Calendar event with Google Meet link.
 * Invites all attendee emails and returns the event link + Meet link.
 */
export async function createMeetingEvent(
  teamMemberId: string,
  event: MeetingEvent
): Promise<CreatedEvent> {
  const calendar = await getCalendarClientForMember(teamMemberId);

  // Unique request ID for idempotent Meet link creation
  const requestId = `proxi-${teamMemberId}-${Date.now()}`;

  const res = await calendar.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all', // sends invite emails to attendees
    requestBody: {
      summary: event.summary,
      description: event.description,
      start: {
        dateTime: event.startTime.toISOString(),
        timeZone: 'America/Los_Angeles',
      },
      end: {
        dateTime: event.endTime.toISOString(),
        timeZone: 'America/Los_Angeles',
      },
      attendees: event.attendeeEmails.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 10 },
        ],
      },
    },
  });

  const ev = res.data;
  const meetLink =
    ev.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri ?? null;

  return {
    eventId: ev.id ?? '',
    eventLink: ev.htmlLink ?? '',
    meetLink,
    startTime: event.startTime.toISOString(),
  };
}

export interface FreeBusyResult {
  memberId: string;
  busy: { start: string; end: string }[];
}

/**
 * Query Google Calendar freebusy API for a single member.
 * Returns busy blocks in the given time range.
 */
export async function getFreeBusy(
  teamMemberId: string,
  timeMin: Date,
  timeMax: Date
): Promise<FreeBusyResult> {
  const calendar = await getCalendarClientForMember(teamMemberId);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: 'primary' }],
    },
  });

  const busy = res.data.calendars?.['primary']?.busy ?? [];

  return {
    memberId: teamMemberId,
    busy: busy
      .map(b => ({ start: b.start ?? '', end: b.end ?? '' }))
      .filter(b => b.start && b.end),
  };
}
