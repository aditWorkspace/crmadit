'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Loader2, Mail, Search } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import { useInboxKeyboard } from '@/hooks/use-inbox-keyboard';
import { useThreadReadState } from '@/hooks/use-thread-read-state';
import { ThreadRow } from './thread-row';
import type { InboxThread } from '@/hooks/use-thread-list';
import type { InboxFilter } from '@/hooks/use-inbox-counts';

const FILTER_LABELS: Record<InboxFilter, string> = {
  needs_response: 'Needs Response',
  unread: 'Unread',
  all: 'All',
  sent: 'Sent',
  snoozed: 'Snoozed',
  archived: 'Archived',
};

interface ThreadListProps {
  threads: InboxThread[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: InboxFilter;
  query: string;
  onQueryChange: (q: string) => void;
  onRefresh: () => void;
  onComposerFocus: () => void;
  patchThread: (id: string, delta: Partial<InboxThread>) => void;
}

export function ThreadList({
  threads,
  loading,
  hasMore,
  onLoadMore,
  selectedId,
  onSelect,
  filter,
  query,
  onQueryChange,
  onRefresh,
  onComposerFocus,
  patchThread,
}: ThreadListProps) {
  const { user } = useSession();
  const { markUnread, markRead } = useThreadReadState();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // IntersectionObserver for cursor pagination
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const target = sentinelRef.current;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !loading) {
          onLoadMore();
        }
      },
      { root: scrollerRef.current, rootMargin: '200px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  // Ensure the selected row is scrolled into view.
  useEffect(() => {
    if (!selectedId || !scrollerRef.current) return;
    const row = scrollerRef.current.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(selectedId)}"]`
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const selectedIndex = useMemo(() => {
    if (!selectedId) return -1;
    return threads.findIndex(t => t.gmail_thread_id === selectedId);
  }, [threads, selectedId]);

  const selectedThread = selectedIndex >= 0 ? threads[selectedIndex] : null;

  // Keyboard handlers
  const handleMove = useCallback(
    (dir: 1 | -1) => {
      if (threads.length === 0) return;
      let next: number;
      if (selectedIndex === -1) {
        next = dir === 1 ? 0 : threads.length - 1;
      } else {
        next = Math.min(threads.length - 1, Math.max(0, selectedIndex + dir));
      }
      onSelect(threads[next].gmail_thread_id);
    },
    [threads, selectedIndex, onSelect]
  );

  const handleArchive = useCallback(async () => {
    if (!selectedThread || !user) return;
    const id = selectedThread.gmail_thread_id;
    const nowIso = new Date().toISOString();
    // Optimistic
    patchThread(id, { archived_at: nowIso });
    try {
      const res = await fetch(
        `/api/inbox/threads/${encodeURIComponent(id)}/archive`,
        {
          method: 'POST',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      if (!res.ok) {
        toast.error('Archive failed');
        patchThread(id, { archived_at: null });
        return;
      }
      toast.success('Archived');
      onRefresh();
    } catch {
      toast.error('Archive failed');
      patchThread(id, { archived_at: null });
    }
  }, [selectedThread, user, patchThread, onRefresh]);

  const handleSnooze = useCallback(() => {
    if (!selectedThread) return;
    window.dispatchEvent(
      new CustomEvent('inbox:open-snooze', {
        detail: { threadId: selectedThread.gmail_thread_id },
      })
    );
  }, [selectedThread]);

  const handleDelete = useCallback(async () => {
    if (!selectedThread) return;
    if (!window.confirm('Archive this thread? You can un-archive later.')) return;
    await handleArchive();
  }, [selectedThread, handleArchive]);

  const handleToggleUnread = useCallback(async () => {
    if (!selectedThread) return;
    const id = selectedThread.gmail_thread_id;
    const wasUnread = selectedThread.is_unread;
    patchThread(id, { is_unread: !wasUnread });
    const ok = wasUnread ? await markRead(id) : await markUnread(id);
    if (!ok) {
      patchThread(id, { is_unread: wasUnread });
      toast.error('Failed to toggle unread');
    } else {
      onRefresh();
    }
  }, [selectedThread, patchThread, markRead, markUnread, onRefresh]);

  useInboxKeyboard({
    onMoveSelection: handleMove,
    onReply: onComposerFocus,
    onArchive: handleArchive,
    onSnooze: handleSnooze,
    onDelete: handleDelete,
    onToggleUnread: handleToggleUnread,
  });

  return (
    <div className="flex flex-col min-h-0 bg-white">
      {/* Header: filter label + search */}
      <div className="flex-shrink-0 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">
            {FILTER_LABELS[filter]}
          </h2>
          <span className="text-xs text-gray-400 tabular-nums">
            {threads.length}
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="search"
            placeholder="Search threads..."
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            className="w-full pl-7 pr-2 py-1.5 text-[13px] border border-gray-200 rounded-md bg-gray-50 focus:bg-white focus:border-gray-300 outline-none transition-colors"
          />
        </div>
      </div>

      {/* List */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 px-4 text-center text-gray-400 gap-2">
            <Mail className="h-8 w-8 text-gray-300" />
            <p className="text-xs">No threads.</p>
          </div>
        ) : (
          <div>
            {threads.map(thread => (
              <ThreadRow
                key={thread.gmail_thread_id}
                thread={thread}
                selected={thread.gmail_thread_id === selectedId}
                onSelect={() => onSelect(thread.gmail_thread_id)}
              />
            ))}
            {hasMore && (
              <div
                ref={sentinelRef}
                className={cn(
                  'py-4 text-center text-xs text-gray-400',
                  loading && 'animate-pulse'
                )}
              >
                {loading ? 'Loading more...' : 'Scroll for more'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
