import type { calendar_v3 } from 'googleapis';
import { getCalendarClientForMember } from './calendar';
import { getGmailClientForMember } from '@/lib/gmail/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { isOutreachThread, extractCompanyFromSubject } from '@/lib/gmail/matcher';
import { normalizeName } from '@/lib/name-utils';

const TEAM_DOMAIN = process.env.TEAM_EMAIL_DOMAIN || 'berkeley.edu';
const LOOKBACK_DAYS = 30;
const FUTURE_DAYS = 30;

// Common personal email domains — don't use their domain as a company name
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'live.com', 'msn.com', 'protonmail.com',
  'protonmail.ch', 'pm.me', 'hey.com', 'fastmail.com',
]);

export interface CalendarSyncResult {
  events_scanned: number;
  leads_created: number;
  leads_updated: number;
  errors: string[];
}

/**
 * Infer a company name from an email domain.
 * Returns null for personal email domains.
 */
function companyFromDomain(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  // "acme.co" → parts = ['acme', 'co'] → take parts[-2] = 'acme' → 'Acme'
  const parts = domain.split('.');
  const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Turn an email local-part into a plausible display name. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || email;
}

/**
 * Search Gmail for any thread with the given email address that matches
 * the outreach subject pattern. Returns { company, threadId } if found.
 */
async function findOutreachThread(
  gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail'],
  contactEmail: string,
): Promise<{ company: string; threadId: string } | null> {
  try {
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: `subject:"product prioritization at" (from:${contactEmail} OR to:${contactEmail})`,
      maxResults: 1,
    });
    const thread = res.data.threads?.[0];
    if (!thread?.id) return null;

    // Fetch the first message to get the subject
    const t = await gmail.users.threads.get({ userId: 'me', id: thread.id, format: 'metadata', metadataHeaders: ['Subject'] });
    const subject = t.data.messages?.[0]?.payload?.headers?.find(h => h.name === 'Subject')?.value || '';
    if (!isOutreachThread(subject)) return null;
    const company = extractCompanyFromSubject(subject);
    if (!company) return null;
    return { company, threadId: thread.id };
  } catch {
    return null;
  }
}

/**
 * Fetch all messages in a Gmail thread and return them as interaction inserts.
 */
async function importThreadMessages(
  gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail'],
  threadId: string,
  leadId: string,
  memberId: string,
  gmailEmail: string,
  supabase: ReturnType<typeof createAdminClient>,
): Promise<void> {
  try {
    const t = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    for (const msg of t.data.messages || []) {
      if (!msg.id) continue;
      const headers = msg.payload?.headers || [];
      const get = (n: string) => headers.find(h => h.name?.toLowerCase() === n)?.value || '';
      const fromEmail = get('from').match(/<([^>]+)>/)?.[1]?.toLowerCase() || get('from').toLowerCase();
      const isOutbound = fromEmail === gmailEmail;
      const subject = get('subject');
      const occurredAt = msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : new Date().toISOString();

      // Extract plain text body
      let bodyText = '';
      type MsgPart = { mimeType?: string | null; body?: { data?: string | null } | null; parts?: MsgPart[] | null };
      const findText = (parts: MsgPart[] | null | undefined): string | null => {
        for (const p of parts || []) {
          if (p.mimeType === 'text/plain' && p.body?.data) return p.body.data;
          if (p.parts) { const f = findText(p.parts); if (f) return f; }
        }
        return null;
      };
      const bodyData = msg.payload?.body?.data || findText(msg.payload?.parts || []);
      if (bodyData) {
        try { bodyText = Buffer.from(bodyData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8').slice(0, 500); } catch {}
      }

      await supabase.from('interactions').insert({
        lead_id: leadId,
        team_member_id: memberId,
        type: isOutbound ? 'email_outbound' : 'email_inbound',
        subject,
        body: bodyText,
        gmail_message_id: msg.id,
        gmail_thread_id: threadId,
        occurred_at: occurredAt,
        metadata: { imported_from_calendar_sync: true },
      }).then(() => {}); // ignore duplicate errors (23505)
    }
  } catch {
    // Non-fatal — thread import is best-effort
  }
}

/**
 * Find the most-recent email thread with this contact (any subject, past 30d).
 * Used to get threadId for linking interactions even when no outreach pattern exists.
 */
async function findAnyRecentThread(
  gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail'],
  contactEmail: string,
): Promise<string | null> {
  try {
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: `(from:${contactEmail} OR to:${contactEmail}) newer_than:30d`,
      maxResults: 1,
    });
    return res.data.threads?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan Google Calendar events from the past 7 days (and upcoming 30 days)
 * and import any meetings with external contacts as leads.
 *
 * For each event with an external attendee:
 *  1. If a lead already exists (by email) → update call timestamps + log the meeting
 *  2. If no lead → search Gmail for outreach threads → create lead with best-effort data
 *
 * Stage logic:
 *  - Event in the past → call_completed
 *  - Event in the future → scheduled
 */
export async function syncCalendarLeads(teamMemberId: string): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = { events_scanned: 0, leads_created: 0, leads_updated: 0, errors: [] };

  const supabase = createAdminClient();

  // Fetch all team members to build the "team email" set used to detect Proxi calls
  const { data: allMembers } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected');

  const member = allMembers?.find(m => m.id === teamMemberId);
  if (!member?.gmail_connected) return result;

  // Build set of all team emails so we can exclude them from "external attendees"
  const otherTeamEmails = new Set<string>();
  const otherMemberIds: string[] = [];
  for (const m of allMembers || []) {
    // Add ALL members' DB emails (including current member) to exclusion set
    if (m.email) otherTeamEmails.add(m.email.toLowerCase());
    if (m.id === teamMemberId) continue;
    otherMemberIds.push(m.id);
  }

  let calendar;
  let gmailClient;
  // Also get Gmail clients for all other connected founders for thread import
  const allGmailClients: Array<{ memberId: string; gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail']; email: string }> = [];
  try {
    calendar = await getCalendarClientForMember(teamMemberId);
    const { gmail } = await getGmailClientForMember(teamMemberId);
    gmailClient = gmail;
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailEmail = profile.data.emailAddress?.toLowerCase() || member.email.toLowerCase();
    otherTeamEmails.add(gmailEmail); // Ensure Gmail profile email is also excluded
    allGmailClients.push({ memberId: teamMemberId, gmail, email: gmailEmail });
    // Try to add other connected founders for thread import
    for (const m of (allMembers || []).filter(m => m.id !== teamMemberId && m.gmail_connected)) {
      try {
        const { gmail: g } = await getGmailClientForMember(m.id);
        const p = await g.users.getProfile({ userId: 'me' });
        const profileEmail = p.data.emailAddress?.toLowerCase() || m.email.toLowerCase();
        otherTeamEmails.add(profileEmail); // Ensure other members' Gmail profile emails are excluded
        allGmailClients.push({ memberId: m.id, gmail: g, email: profileEmail });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    result.errors.push(`Auth error: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const now = new Date();
  const timeMin = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + FUTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Collect all events with pagination
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    for (const ev of res.data.items || []) {
      events.push(ev);
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  // Track which contacts we've already processed this run to avoid duplicates
  const processedEmails = new Set<string>();

  for (const event of events) {
    // Skip all-day events (no time component = likely not a sales call)
    if (!event.start?.dateTime) continue;
    // Skip cancelled events
    if (event.status === 'cancelled') continue;

    result.events_scanned++;

    const eventStart = new Date(event.start.dateTime);
    const eventId = event.id || '';
    const isPast = eventStart < now;

    // Get external (non-team) attendees — these are the prospects
    const externalAttendees = (event.attendees || []).filter((a: calendar_v3.Schema$EventAttendee) => {
      const email = a.email?.toLowerCase() || '';
      if (!email || a.resource) return false;
      if (email.endsWith(`@${TEAM_DOMAIN}`)) return false;
      // Also exclude any known team alternate emails
      if (otherTeamEmails.has(email)) return false;
      // Skip declined attendees
      if (a.responseStatus === 'declined') return false;
      return true;
    });

    if (externalAttendees.length === 0) continue;

    for (const attendee of externalAttendees) {
      const contactEmail = attendee.email?.toLowerCase();
      if (!contactEmail || processedEmails.has(contactEmail)) continue;
      processedEmails.add(contactEmail);

      try {
        await processCalendarAttendee({
          supabase,
          gmail: gmailClient,
          allGmailClients,
          member,
          contactEmail,
          attendeeDisplayName: attendee.displayName || null,
          event: {
            id: eventId,
            summary: event.summary || '',
            startTime: eventStart,
            isPast,
            meetLink: event.conferenceData?.entryPoints?.find((ep: calendar_v3.Schema$EntryPoint) => ep.entryPointType === 'video')?.uri ?? null,
          },
          result,
        });
      } catch (err) {
        result.errors.push(`${contactEmail}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

async function processCalendarAttendee({
  supabase,
  gmail,
  allGmailClients,
  member,
  contactEmail,
  attendeeDisplayName,
  event,
  result,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail'];
  allGmailClients: Array<{ memberId: string; gmail: Awaited<ReturnType<typeof getGmailClientForMember>>['gmail']; email: string }>;
  member: { id: string; name: string; email: string };
  contactEmail: string;
  attendeeDisplayName: string | null;
  event: { id: string; summary: string; startTime: Date; isPast: boolean; meetLink: string | null };
  result: CalendarSyncResult;
}) {
  const now = new Date();

  // Check if lead already exists — globally across ALL owners to prevent duplicates
  const { data: existingLead } = await supabase
    .from('leads')
    .select('id, stage, call_scheduled_for, call_completed_at, owned_by')
    .eq('contact_email', contactEmail)
    .eq('is_archived', false)
    .not('stage', 'in', '("dead")')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Check if we've already logged this calendar event for this lead
  const alreadyLoggedCheck = existingLead
    ? await supabase
        .from('interactions')
        .select('id')
        .eq('lead_id', existingLead.id)
        .contains('metadata', { calendar_event_id: event.id })
        .limit(1)
        .maybeSingle()
    : { data: null };

  if (existingLead) {
    // Update call timestamps if not already set
    const updates: Record<string, unknown> = {};
    if (event.isPast && !existingLead.call_completed_at) {
      updates.call_completed_at = event.startTime.toISOString();
      // Only advance stage if currently at a pre-call stage
      if (['replied', 'scheduling', 'scheduled'].includes(existingLead.stage)) {
        updates.stage = 'call_completed';
      }
    } else if (!event.isPast) {
      // Always update call_scheduled_for — handles reschedules (time changes)
      const existingTime = existingLead.call_scheduled_for
        ? new Date(existingLead.call_scheduled_for).getTime()
        : 0;
      const newTime = event.startTime.getTime();
      if (existingTime !== newTime) {
        updates.call_scheduled_for = event.startTime.toISOString();
      }
      if (['replied', 'scheduling'].includes(existingLead.stage)) {
        updates.stage = 'scheduled';
        updates.priority = 'high';
      }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from('leads').update({ ...updates, updated_at: now.toISOString() }).eq('id', existingLead.id);
    }

    // Log interaction if not already done
    if (!alreadyLoggedCheck.data) {
      const interactionBody = [
        event.isPast ? 'Call completed.' : 'Call scheduled.',
        event.meetLink ? `Google Meet: ${event.meetLink}` : null,
      ].filter(Boolean).join('\n');

      await supabase.from('interactions').insert({
        lead_id: existingLead.id,
        team_member_id: member.id,
        type: 'other',
        subject: event.summary || `Meeting on ${event.startTime.toLocaleDateString()}`,
        body: interactionBody,
        occurred_at: event.startTime.toISOString(),
        metadata: {
          calendar_event_id: event.id,
          meet_link: event.meetLink,
          source: 'calendar_sync',
        },
      });

      result.leads_updated++;
    }
    return;
  }

  // ── No existing lead — skip ────────────────────────────────────────────────
  // Calendar sync only updates existing leads (created from email outreach).
  // It never creates new leads — too many false positives from personal/academic events.
}
