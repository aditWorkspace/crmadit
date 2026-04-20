/**
 * Auto-mention on human inbound replies.
 *
 * Every time sync stores a genuine inbound email (not calendar noise, not a
 * bounce, not our own outbound), we drop an internal comment on the thread
 * that @-mentions the lead owner. The comment insert triggers the existing
 * `mention_notifications` insert path (see POST /api/threads/.../comments),
 * which lights up the bell in the top nav.
 *
 * Dedupe rule: at most one *unread* mention per (recipient, thread) at a
 * time. Subsequent replies on the same thread don't stack; the owner
 * dismisses once and we re-tag on the next inbound after that.
 */

import { createAdminClient } from '@/lib/supabase/admin';

type Supabase = ReturnType<typeof createAdminClient>;

export async function tagInboundForReview(args: {
  supabase: Supabase;
  leadId: string;
  ownerId: string;
  threadId: string | null | undefined;
  subject: string;
  bodyPreview: string;
}): Promise<void> {
  const { supabase, ownerId, threadId, subject, bodyPreview } = args;
  if (!threadId) return;

  // Dedupe: skip if there's already an unread mention for this recipient on
  // this thread. We don't pile on; one badge per open thread.
  const { data: existing } = await supabase
    .from('mention_notifications')
    .select('id')
    .eq('recipient_id', ownerId)
    .eq('gmail_thread_id', threadId)
    .is('read_at', null)
    .limit(1);
  if (existing && existing.length > 0) return;

  // Pick a co-founder as the comment author — thread_comments.author_id is
  // NOT NULL, and the POST route excludes the author from mentions, so the
  // author has to be someone other than the recipient.
  const { data: author } = await supabase
    .from('team_members')
    .select('id')
    .neq('id', ownerId)
    .limit(1)
    .maybeSingle();
  if (!author) return;

  const snippet = bodyPreview.replace(/\s+/g, ' ').trim().slice(0, 140);
  const body = `New inbound reply — "${subject}"${snippet ? `: ${snippet}${snippet.length === 140 ? '…' : ''}` : ''}. Needs your review.`;

  const { data: comment, error: commentErr } = await supabase
    .from('thread_comments')
    .insert({
      gmail_thread_id: threadId,
      author_id: author.id,
      body,
      mentioned_ids: [ownerId],
    })
    .select('id')
    .single();
  if (commentErr || !comment) return;

  await supabase.from('mention_notifications').insert({
    recipient_id: ownerId,
    comment_id: comment.id,
    gmail_thread_id: threadId,
  });
}
