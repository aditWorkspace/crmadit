import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

type Author = { id: string; name: string; email: string };

type CommentRow = {
  id: string;
  gmail_thread_id: string;
  body: string;
  mentioned_ids: string[] | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author: Author | null;
};

export async function GET(
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
  const { data, error } = await supabase
    .from('thread_comments')
    .select(
      `
      id, gmail_thread_id, body, mentioned_ids, created_at, updated_at, deleted_at,
      author:team_members!thread_comments_author_id_fkey(id, name, email)
      `
    )
    .eq('gmail_thread_id', threadId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data || []) as unknown as CommentRow[];
  const comments = rows.map((r) => ({
    id: r.id,
    gmail_thread_id: r.gmail_thread_id,
    author: r.author,
    body: r.body,
    mentioned_ids: r.mentioned_ids ?? [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return NextResponse.json({ comments });
}

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

  const payload = await req.json().catch(() => ({}));
  const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
  const mentioned_ids: string[] = Array.isArray(payload?.mentioned_ids)
    ? payload.mentioned_ids.filter((x: unknown) => typeof x === 'string')
    : [];

  if (!body) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: inserted, error } = await supabase
    .from('thread_comments')
    .insert({
      gmail_thread_id: threadId,
      author_id: session.id,
      body,
      mentioned_ids,
    })
    .select(
      `
      id, gmail_thread_id, body, mentioned_ids, created_at, updated_at, deleted_at,
      author:team_members!thread_comments_author_id_fkey(id, name, email)
      `
    )
    .single();

  if (error || !inserted) {
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  const row = inserted as unknown as CommentRow;

  // Create notifications for mentioned members (excluding author)
  const recipientIds = Array.from(new Set(mentioned_ids)).filter((id) => id !== session.id);
  if (recipientIds.length > 0) {
    const notifRows = recipientIds.map((rid) => ({
      recipient_id: rid,
      comment_id: row.id,
      gmail_thread_id: threadId,
    }));
    await supabase.from('mention_notifications').insert(notifRows);
  }

  return NextResponse.json(
    {
      comment: {
        id: row.id,
        gmail_thread_id: row.gmail_thread_id,
        author: row.author,
        body: row.body,
        mentioned_ids: row.mentioned_ids ?? [],
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    },
    { status: 201 }
  );
}
