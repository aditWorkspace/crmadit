// Diagnostic: search Gmail for threads matching a free-text query (name,
// keyword, etc.) and report subject + participant emails + whether the
// subject matches our outreach pattern. Used to find leads booked under
// one email but originally contacted via another.
//
// REMOVE after the investigation is complete.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getGmailClientForMember } from '@/lib/gmail/client';
import { isOutreachThread, extractCompanyFromSubject } from '@/lib/gmail/matcher';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = req.nextUrl.searchParams.get('q');
  if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 });

  try {
    const { gmail } = await getGmailClientForMember(session.id);
    const res = await gmail.users.threads.list({
      userId: 'me',
      q,
      maxResults: 25,
    });

    const threads: Array<Record<string, unknown>> = [];
    for (const t of res.data.threads ?? []) {
      if (!t.id) continue;
      const meta = await gmail.users.threads.get({
        userId: 'me',
        id: t.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'],
      });
      const messages = meta.data.messages ?? [];
      const firstHeaders = messages[0]?.payload?.headers ?? [];
      const headerVal = (n: string) => firstHeaders.find(h => h.name === n)?.value ?? '';
      const subject = headerVal('Subject');
      // Collect every email address that appears in From/To/Cc across all
      // messages in the thread, so we can spot alternate contact addresses.
      const emails = new Set<string>();
      for (const m of messages) {
        for (const h of m.payload?.headers ?? []) {
          if (!h.value) continue;
          if (h.name !== 'From' && h.name !== 'To' && h.name !== 'Cc') continue;
          for (const match of h.value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
            emails.add(match[0].toLowerCase());
          }
        }
      }
      threads.push({
        threadId: t.id,
        subject,
        date: headerVal('Date'),
        message_count: messages.length,
        matches_outreach_pattern: isOutreachThread(subject),
        extracted_company: isOutreachThread(subject) ? extractCompanyFromSubject(subject) : null,
        participant_emails: [...emails],
      });
    }

    return NextResponse.json({ q, count: threads.length, threads });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
