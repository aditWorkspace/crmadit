'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/ui/relative-time';
import { useSession } from '@/hooks/use-session';
import { BellOff } from '@/lib/icons';

export interface MentionNotification {
  id: string;
  comment_id: string;
  gmail_thread_id: string;
  created_at: string;
  read_at: string | null;
  comment: {
    body: string;
    author: { id: string; name: string } | null;
  } | null;
}

interface NotificationListProps {
  notifications: MentionNotification[];
  onChange: () => void;
  onClose?: () => void;
}

function snippet(body: string, max = 120): string {
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}

export function NotificationList({
  notifications,
  onChange,
  onClose,
}: NotificationListProps) {
  const { user } = useSession();
  const router = useRouter();

  const markAll = async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/notifications/mark-all-read', {
        method: 'POST',
        headers: { 'x-team-member-id': user.team_member_id },
      });
      if (!res.ok) {
        toast.error('Failed to mark all read');
        return;
      }
      onChange();
    } catch {
      toast.error('Failed to mark all read');
    }
  };

  const open = async (n: MentionNotification) => {
    if (!user) return;
    // Mark as read (fire-and-forget)
    if (!n.read_at) {
      fetch(`/api/notifications/${n.id}/read`, {
        method: 'POST',
        headers: { 'x-team-member-id': user.team_member_id },
      })
        .then(() => onChange())
        .catch(() => {
          /* ignore */
        });
    }
    onClose?.();
    router.push(`/inbox?thread=${encodeURIComponent(n.gmail_thread_id)}`);
  };

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Mentions
        </span>
        <button
          type="button"
          onClick={markAll}
          disabled={unreadCount === 0}
          className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40"
        >
          Mark all read
        </button>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-gray-400">
            <BellOff className="mb-2 h-5 w-5 text-gray-300" />
            No mentions yet
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {notifications.map((n) => {
              const authorName = n.comment?.author?.name ?? 'Someone';
              const body = n.comment?.body ?? '';
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[color:var(--surface-muted)]',
                      !n.read_at && 'bg-blue-50/40'
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 flex-shrink-0 rounded-full',
                        n.read_at ? 'bg-transparent' : 'bg-blue-500'
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-gray-800">
                        <span className="font-medium">{authorName}</span>{' '}
                        <span className="text-gray-500">
                          mentioned you in a thread
                        </span>
                      </p>
                      {body && (
                        <p className="mt-0.5 truncate text-xs text-gray-500">
                          {snippet(body, 100)}
                        </p>
                      )}
                      <p className="mt-0.5 text-[10px] text-gray-400">
                        <RelativeTime date={n.created_at} />
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
