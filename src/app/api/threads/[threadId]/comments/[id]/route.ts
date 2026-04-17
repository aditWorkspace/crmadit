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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string; id: string }> }
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const payload = await req.json().catch(() => ({}));

  const updates: Record<string, unknown> = {};
  if (typeof payload?.body === 'string') {
    const trimmed = payload.body.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'body cannot be empty' }, { status: 400 });
    }
    updates.body = trimmed;
  }
  if (Array.isArray(payload?.mentioned_ids)) {
    updates.mentioned_ids = payload.mentioned_ids.filter((x: unknown) => typeof x === 'string');
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('thread_comments')
    .update(updates)
    .eq('id', id)
    .eq('author_id', session.id)
    .is('deleted_at', null)
    .select(
      `
      id, gmail_thread_id, body, mentioned_ids, created_at, updated_at, deleted_at,
      author:team_members!thread_comments_author_id_fkey(id, name, email)
      `
    )
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Not found or not authorised' }, { status: 404 });
  }

  const row = data as unknown as CommentRow;
  return NextResponse.json({
    comment: {
      id: row.id,
      gmail_thread_id: row.gmail_thread_id,
      author: row.author,
      body: row.body,
      mentioned_ids: row.mentioned_ids ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string; id: string }> }
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('thread_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('author_id', session.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Not found or not authorised' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
