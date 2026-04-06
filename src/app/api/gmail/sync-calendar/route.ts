import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { syncCalendarLeads } from '@/lib/google/calendar-sync';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await syncCalendarLeads(session.id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('insufficientPermissions') || message.includes('forbidden')) {
      return NextResponse.json(
        { error: 'Calendar permission missing — disconnect and reconnect Google in Settings.' },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
