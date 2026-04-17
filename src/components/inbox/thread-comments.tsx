'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { extractMentionedIds, type MentionMember } from '@/lib/mentions/parse';
import { MentionInput } from './mention-input';
import { CommentCard, type ThreadComment } from './comment-card';
import { Loader2 } from '@/lib/icons';

interface ThreadCommentsProps {
  threadId: string;
}

interface ApiMember {
  id: string;
  name: string;
  email: string;
}

export function ThreadComments({ threadId }: ThreadCommentsProps) {
  const { user } = useSession();
  const [members, setMembers] = useState<ApiMember[]>([]);
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const commentsRef = useRef<ThreadComment[]>([]);
  commentsRef.current = comments;

  // Fetch members (public endpoint)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/team/members')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data?.members)) {
          setMembers(data.members);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch comments
  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}/comments`,
        { headers: { 'x-team-member-id': user.team_member_id } }
      );
      if (!res.ok) {
        setComments([]);
        return;
      }
      const data = await res.json();
      setComments(Array.isArray(data?.comments) ? data.comments : []);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [threadId, user]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Realtime subscribe — append comments inserted by other users
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`thread-comments:${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'thread_comments',
          filter: `gmail_thread_id=eq.${threadId}`,
        },
        () => {
          // Simplest correct approach: re-fetch to get author join.
          load();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'thread_comments',
          filter: `gmail_thread_id=eq.${threadId}`,
        },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [threadId, load]);

  const memberLite: MentionMember[] = members.map((m) => ({ id: m.id, name: m.name }));

  const handleSubmit = async (text: string) => {
    if (!user) return;
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    const mentioned_ids = extractMentionedIds(trimmed, memberLite);

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}/comments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-team-member-id': user.team_member_id,
          },
          body: JSON.stringify({ body: trimmed, mentioned_ids }),
        }
      );
      if (!res.ok) {
        toast.error('Failed to post comment');
        return;
      }
      const data = await res.json();
      if (data?.comment) {
        // Optimistically append (realtime will no-op because row already present)
        setComments((prev) => {
          if (prev.some((c) => c.id === data.comment.id)) return prev;
          return [...prev, data.comment];
        });
      }
      setDraft('');
    } catch {
      toast.error('Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleted = (id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="flex-shrink-0 border-t border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)]/40 px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="label-uppercase text-[10px] font-semibold tracking-wider text-gray-500">
          Internal
        </span>
        <span className="text-[11px] text-gray-400">
          Only Adit, Srijay, and Asim can see comments.
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading comments…
        </div>
      ) : (
        <>
          {comments.length === 0 ? (
            <p className="mb-3 text-xs text-gray-400">
              No comments yet. Use @ to mention a teammate.
            </p>
          ) : (
            <div className="space-y-2 mb-3">
              {comments.map((c) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  members={memberLite}
                  onDeleted={handleDeleted}
                />
              ))}
            </div>
          )}
        </>
      )}

      <MentionInput
        value={draft}
        onChange={setDraft}
        members={members}
        placeholder="Add a comment… use @ to mention a teammate. Enter to post, Shift+Enter for newline."
        onSubmit={handleSubmit}
        disabled={submitting || !user}
      />
    </div>
  );
}
