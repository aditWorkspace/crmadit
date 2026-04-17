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

  const now = new Date().toISOString();
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('thread_state')
    .upsert(
      {
        gmail_thread_id: threadId,
        archived_at: now,
        archived_by: session.id,
        updated_at: now,
      },
      { onConflict: 'gmail_thread_id' }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, archived_at: now });
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
        archived_at: null,
        archived_by: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'gmail_thread_id' }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
