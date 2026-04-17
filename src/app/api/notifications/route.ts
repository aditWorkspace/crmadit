import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

type CommentRef = {
  id: string;
  body: string;
  author: { id: string; name: string } | null;
};

type NotifRow = {
  id: string;
  comment_id: string;
  gmail_thread_id: string;
  created_at: string;
  read_at: string | null;
  comment: CommentRef | null;
};

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const unreadOnly = req.nextUrl.searchParams.get('unread_only') === 'true';

  const supabase = createAdminClient();

  let query = supabase
    .from('mention_notifications')
    .select(
      `
      id, comment_id, gmail_thread_id, created_at, read_at,
      comment:thread_comments!mention_notifications_comment_id_fkey(
        id, body,
        author:team_members!thread_comments_author_id_fkey(id, name)
      )
      `
    )
    .eq('recipient_id', session.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (unreadOnly) {
    query = query.is('read_at', null);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { count: unreadCount } = await supabase
    .from('mention_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', session.id)
    .is('read_at', null);

  const rows = (data || []) as unknown as NotifRow[];
  const notifications = rows.map((r) => ({
    id: r.id,
    comment_id: r.comment_id,
    gmail_thread_id: r.gmail_thread_id,
    created_at: r.created_at,
    read_at: r.read_at,
    comment: r.comment
      ? {
          body: r.comment.body,
          author: r.comment.author,
        }
      : null,
  }));

  return NextResponse.json({
    notifications,
    unread_count: unreadCount ?? 0,
  });
}
