// One-off diagnostic for "where is <email>?". Searches Gmail (via the
// session user's connected account) for any thread with the address,
// reports subject + thread id + match against our outreach patterns.
// Also reports calendar event matches if found.
//
// REMOVE after the investigation is complete.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getGmailClientForMember } from '@/lib/gmail/client';
import { getCalendarClientForMember } from '@/lib/google/calendar';
import { isOutreachThread, extractCompanyFromSubject } from '@/lib/gmail/matcher';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = req.nextUrl.searchParams.get('email');
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });

  const out: Record<string, unknown> = { email, member: session.name };

  // Gmail threads.
  try {
    const { gmail } = await getGmailClientForMember(session.id);
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: `(from:${email} OR to:${email})`,
      maxResults: 10,
    });
    const threads: Array<Record<string, unknown>> = [];
    for (const t of res.data.threads ?? []) {
      if (!t.id) continue;
      const meta = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Date'] });
      const headers = meta.data.messages?.[0]?.payload?.headers ?? [];
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const matchesOutreachPattern = isOutreachThread(subject);
      threads.push({
        threadId: t.id,
        subject,
        date,
        message_count: meta.data.messages?.length ?? 0,
        matches_outreach_pattern: matchesOutreachPattern,
        extracted_company: matchesOutreachPattern ? extractCompanyFromSubject(subject) : null,
      });
    }
    out.gmail_threads = threads;
  } catch (e) {
    out.gmail_error = e instanceof Error ? e.message : String(e);
  }

  // Calendar events.
  try {
    const calendar = await getCalendarClientForMember(session.id);
    const cutoffPast = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const cutoffFuture = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const events = await calendar.events.list({
      calendarId: 'primary',
      q: email,
      timeMin: cutoffPast,
      timeMax: cutoffFuture,
      singleEvents: true,
      maxResults: 10,
    });
    out.calendar_events = (events.data.items ?? []).map(ev => ({
      summary: ev.summary,
      start: ev.start?.dateTime ?? ev.start?.date,
      attendees: (ev.attendees ?? []).map(a => a.email),
      organizer: ev.organizer?.email,
    }));
  } catch (e) {
    out.calendar_error = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(out);
}
