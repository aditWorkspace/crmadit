import type { gmail_v1 } from 'googleapis';

export interface CalendarEvent {
  startTime: Date;
  summary: string;
  organizerEmail: string;
  attendeeEmails: string[];
}

function extractCalendarText(
  parts: gmail_v1.Schema$MessagePart[] | undefined
): string | null {
  if (!parts) return null;
  for (const part of parts) {
    if (part.mimeType === 'text/calendar' && part.body?.data) {
      return Buffer.from(
        part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf-8');
    }
    if (part.parts) {
      const found = extractCalendarText(part.parts);
      if (found) return found;
    }
  }
  return null;
}

function parseIcsDate(dtstart: string): Date | null {
  try {
    // UTC: 20250401T170000Z
    if (dtstart.endsWith('Z')) {
      const y = dtstart.slice(0, 4);
      const mo = dtstart.slice(4, 6);
      const d = dtstart.slice(6, 8);
      const h = dtstart.slice(9, 11);
      const mi = dtstart.slice(11, 13);
      const s = dtstart.slice(13, 15);
      return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    }
    // All-day date: 20250401
    if (dtstart.length === 8) {
      const y = dtstart.slice(0, 4);
      const mo = dtstart.slice(4, 6);
      const d = dtstart.slice(6, 8);
      return new Date(`${y}-${mo}-${d}T00:00:00Z`);
    }
    // Local with TZID — treat as UTC approximation (close enough for scheduling)
    if (dtstart.includes('T')) {
      const digits = dtstart.replace(/[^0-9T]/g, '');
      const y = digits.slice(0, 4);
      const mo = digits.slice(4, 6);
      const d = digits.slice(6, 8);
      const tIdx = digits.indexOf('T');
      const h = digits.slice(tIdx + 1, tIdx + 3);
      const mi = digits.slice(tIdx + 3, tIdx + 5);
      const s = digits.slice(tIdx + 5, tIdx + 7) || '00';
      return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    }
    return null;
  } catch {
    return null;
  }
}

function extractEmailFromIcsValue(value: string): string {
  const match = value.match(/mailto:([^\s;]+)/i);
  return match ? match[1].toLowerCase() : value.toLowerCase().trim();
}

function getIcsField(ics: string, field: string): string | null {
  const regex = new RegExp(`^${field}[^:]*:(.*)`, 'm');
  const match = ics.match(regex);
  return match ? match[1].replace(/\r/g, '').trim() : null;
}

function getIcsFieldAll(ics: string, field: string): string[] {
  const regex = new RegExp(`^${field}[^:]*:(.*)`, 'gm');
  const results: string[] = [];
  let m;
  while ((m = regex.exec(ics)) !== null) {
    results.push(m[1].replace(/\r/g, '').trim());
  }
  return results;
}

/**
 * Parse a Gmail message for a Google Calendar invite.
 * Returns event details if an ICS invite is found, null otherwise.
 */
export function parseCalendarInvite(
  message: gmail_v1.Schema$Message
): CalendarEvent | null {
  const allParts = message.payload?.parts ?? (message.payload ? [message.payload] : undefined);
  const icsText = extractCalendarText(allParts);
  if (!icsText) return null;

  // Skip cancellations and replies — only process new invites
  const method = getIcsField(icsText, 'METHOD');
  if (method && !['REQUEST', 'PUBLISH'].includes(method.toUpperCase())) return null;

  const dtstartRaw = getIcsField(icsText, 'DTSTART');
  if (!dtstartRaw) return null;

  const startTime = parseIcsDate(dtstartRaw);
  if (!startTime) return null;

  const summary = getIcsField(icsText, 'SUMMARY') ?? 'Call';
  const organizerRaw = getIcsField(icsText, 'ORGANIZER') ?? '';
  const organizerEmail = extractEmailFromIcsValue(organizerRaw);
  const attendeeRaws = getIcsFieldAll(icsText, 'ATTENDEE');
  const attendeeEmails = attendeeRaws.map(extractEmailFromIcsValue).filter(Boolean);

  return { startTime, summary, organizerEmail, attendeeEmails };
}
