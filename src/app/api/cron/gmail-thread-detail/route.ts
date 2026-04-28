// Diagnostic: dump a Gmail thread's headers + first 500 chars of each
// message body. Used to look at the original outreach we suspect was
// missed by the matcher.
//
// REMOVE after the investigation is complete.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getGmailClientForMember } from '@/lib/gmail/client';

function decodeB64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractText(payload: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null; parts?: unknown[] }> | null } | null | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    try { return decodeB64Url(payload.body.data); } catch { return ''; }
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractText(p as Parameters<typeof extractText>[0]);
      if (t) return t;
    }
  }
  return '';
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const { gmail } = await getGmailClientForMember(session.id);
    const res = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
    const messages = (res.data.messages ?? []).map(m => {
      const headers = m.payload?.headers ?? [];
      const h = (n: string) => headers.find(x => x.name === n)?.value ?? '';
      const body = extractText(m.payload as Parameters<typeof extractText>[0]).slice(0, 500);
      return {
        id: m.id,
        from: h('From'),
        to: h('To'),
        cc: h('Cc'),
        date: h('Date'),
        subject: h('Subject'),
        snippet: m.snippet,
        body_excerpt: body,
      };
    });
    return NextResponse.json({ id, message_count: messages.length, messages });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
