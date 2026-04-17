'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ownerColor } from '@/lib/colors';
import { RelativeTime } from '@/components/ui/relative-time';
import { renderMentionsReact, type MentionMember } from '@/lib/mentions/parse';
import { useSession } from '@/hooks/use-session';
import { Trash2 } from '@/lib/icons';

export interface ThreadComment {
  id: string;
  gmail_thread_id: string;
  author: { id: string; name: string; email: string } | null;
  body: string;
  mentioned_ids: string[];
  created_at: string;
  updated_at: string;
}

interface CommentCardProps {
  comment: ThreadComment;
  members: MentionMember[];
  onDeleted?: (commentId: string) => void;
}

export function CommentCard({ comment, members, onDeleted }: CommentCardProps) {
  const { user } = useSession();
  const [deleting, setDeleting] = useState(false);
  const authorName = comment.author?.name ?? 'Unknown';
  const oc = ownerColor(authorName);
  const isAuthor = user?.team_member_id === comment.author?.id;

  const handleDelete = async () => {
    if (!user || !isAuthor) return;
    if (!window.confirm('Delete this comment?')) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/threads/${encodeURIComponent(comment.gmail_thread_id)}/comments/${comment.id}`,
        {
          method: 'DELETE',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      if (!res.ok) {
        toast.error('Failed to delete comment');
        return;
      }
      toast.success('Comment deleted');
      onDeleted?.(comment.id);
    } catch {
      toast.error('Failed to delete comment');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group chat-card relative">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn('h-2 w-2 rounded-full flex-shrink-0', oc.dot)}
            aria-hidden
          />
          <span className={cn('text-sm font-medium', oc.text)}>{authorName}</span>
          <span className="text-xs text-gray-400">
            <RelativeTime date={comment.created_at} />
          </span>
          {comment.updated_at !== comment.created_at && (
            <span className="text-xs italic text-gray-400">(edited)</span>
          )}
        </div>

        {isAuthor && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 flex-shrink-0"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        )}
      </div>

      <div className="prose-chat mt-2 whitespace-pre-wrap break-words text-sm text-gray-800">
        {renderMentionsReact(comment.body, members)}
      </div>
    </div>
  );
}
