import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { threadId } = await params;
  if (!threadId) {
    return NextResponse.json({ error: 'Missing threadId' }, { status: 400 });
  }

  let body: { snoozed_until?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const raw = body.snoozed_until;
  if (typeof raw !== 'string' || !raw) {
    return NextResponse.json({ error: 'snoozed_until required (ISO string)' }, { status: 400 });
  }
  const snoozedMs = new Date(raw).getTime();
  if (!Number.isFinite(snoozedMs)) {
    return NextResponse.json({ error: 'snoozed_until must be a valid ISO timestamp' }, { status: 400 });
  }
  const snoozedIso = new Date(snoozedMs).toISOString();

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('thread_state')
    .upsert(
      {
        gmail_thread_id: threadId,
        snoozed_until: snoozedIso,
        snoozed_by: session.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'gmail_thread_id' }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, snoozed_until: snoozedIso });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { threadId } = await params;
  if (!threadId) {
    return NextResponse.json({ error: 'Missing threadId' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('thread_state')
    .upsert(
      {
        gmail_thread_id: threadId,
        snoozed_until: null,
        snoozed_by: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'gmail_thread_id' }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
