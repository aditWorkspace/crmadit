import type { gmail_v1 } from 'googleapis';

/**
 * Detect Google Calendar notification emails that should be dropped from the
 * inbox. We still let `parseCalendarInvite` extract scheduling info from
 * REQUEST/PUBLISH invites upstream; this filter just prevents the raw
 * "Declined: …", "Updated invitation: …", "Accepted: …" emails from being
 * stored as interactions (they're noise that crowds the Needs Response list).
 *
 * Signals (any one is enough):
 *   1. Sender is Google's calendar-notification address
 *   2. Subject starts with a calendar verb prefix
 *   3. Body is the structured Google-Meet/Join-by-phone block with no real
 *      prose on top (rare — usually (1) or (2) catch it first)
 */

const CAL_FROM_RE = /calendar-notification@google\.com/i;

const CAL_SUBJECT_PREFIXES = [
  /^invitation:\s/i,
  /^updated invitation:\s/i,
  /^accepted:\s/i,
  /^declined:\s/i,
  /^tentatively accepted:\s/i,
  /^tentative:\s/i,
  /^canceled event:\s/i,
  /^cancelled event:\s/i,
  /^canceled:\s/i,
  /^cancelled:\s/i,
  /^rescheduled event:\s/i,
];

// Short bodies dominated by the Google Meet / Join-by-phone scaffolding.
// We only match when the scaffolding lines make up most of the message — so
// a prospect who quotes a Meet link inside their own reply still goes through.
const CAL_BODY_MARKERS = [
  /Join with Google Meet/i,
  /Join by phone/i,
  /\bmeet\.google\.com\/[a-z0-9-]+/i,
];

function isCalendarNoiseBody(body: string): boolean {
  if (!body) return false;
  const markers = CAL_BODY_MARKERS.filter(re => re.test(body)).length;
  if (markers < 2) return false;
  // If the body is mostly prose, let it through — a real reply that happens
  // to paste the meet link is still a human reply.
  const nonBlank = body.split('\n').filter(l => l.trim().length > 0);
  const scaffoldLines = nonBlank.filter(l =>
    /^(Join with Google Meet|Join by phone|\(US\) \+|PIN:|Organizer|Guests?|View all guest info|https?:\/\/(meet|calendar)\.google\.com|This event)/i.test(l.trim())
  ).length;
  return scaffoldLines >= Math.max(3, nonBlank.length * 0.5);
}

export function isCalendarNoise(
  fromHeader: string,
  subject: string,
  bodyPreview: string
): boolean {
  if (CAL_FROM_RE.test(fromHeader)) return true;
  if (CAL_SUBJECT_PREFIXES.some(re => re.test(subject.trim()))) return true;
  if (isCalendarNoiseBody(bodyPreview)) return true;
  return false;
}

/**
 * Secondary belt-and-suspenders check: if the message carries an ICS part
 * whose METHOD is anything other than REQUEST/PUBLISH (i.e. REPLY, CANCEL,
 * COUNTER, REFRESH), it's a calendar-state notification, not a real invite.
 * `parseCalendarInvite` already returns null for these, but it doesn't tell
 * us *why*, so we look at the raw ICS here.
 */
export function hasNonInviteIcsMethod(
  message: gmail_v1.Schema$Message
): boolean {
  const allParts = message.payload?.parts ?? (message.payload ? [message.payload] : undefined);
  const ics = findCalendarPart(allParts);
  if (!ics) return false;
  const method = ics.match(/^METHOD[^:]*:(.*)$/m)?.[1]?.trim().toUpperCase();
  if (!method) return false;
  return method !== 'REQUEST' && method !== 'PUBLISH';
}

function findCalendarPart(parts: gmail_v1.Schema$MessagePart[] | undefined): string | null {
  if (!parts) return null;
  for (const part of parts) {
    if (part.mimeType === 'text/calendar' && part.body?.data) {
      return Buffer.from(
        part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf-8');
    }
    if (part.parts) {
      const found = findCalendarPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}
