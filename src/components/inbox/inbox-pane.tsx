'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { useInboxCounts, type InboxFilter } from '@/hooks/use-inbox-counts';
import { useThreadList } from '@/hooks/use-thread-list';
import { useInboxRealtime } from '@/hooks/use-inbox-realtime';
import { FolderRail } from './folder-rail';
import { ThreadList } from './thread-list';
import { ThreadReader } from './thread-reader';
import { EmptyState } from './empty-state';

const FILTER_STORAGE_KEY = 'proxi-inbox-filter';
const OWNER_STORAGE_KEY = 'proxi-inbox-owner';
const MIDDLE_WIDTH_KEY = 'proxi-inbox-middle-width';

const VALID_FILTERS: InboxFilter[] = [
  'needs_response',
  'all',
  'sent',
  'snoozed',
  'archived',
  'unread',
];

export function InboxPane() {
  const searchParams = useSearchParams();
  const deepLinkThreadId = searchParams.get('thread');
  const consumedDeepLink = useRef(false);

  const [filter, setFilterRaw] = useState<InboxFilter>('needs_response');
  const [owner, setOwnerRaw] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [middleWidth, setMiddleWidth] = useState(360);
  const [composerOpen, setComposerOpen] = useState(false);

  // Restore persisted filter/owner
  useEffect(() => {
    try {
      const f = localStorage.getItem(FILTER_STORAGE_KEY) as InboxFilter | null;
      if (f && VALID_FILTERS.includes(f)) setFilterRaw(f);
      const o = localStorage.getItem(OWNER_STORAGE_KEY);
      if (o) setOwnerRaw(o);
    } catch {
      /* ignore */
    }
  }, []);

  const setFilter = useCallback((f: InboxFilter) => {
    setFilterRaw(f);
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, f);
    } catch {
      /* ignore */
    }
    // When switching folders, clear the selection so the reader shows the
    // empty state instead of a thread that may not belong to the new list.
    setSelectedId(null);
    setComposerOpen(false);
  }, []);

  const setOwner = useCallback((o: string) => {
    setOwnerRaw(o);
    try {
      localStorage.setItem(OWNER_STORAGE_KEY, o);
    } catch {
      /* ignore */
    }
  }, []);

  const { threads, loading, hasMore, loadMore, refresh, patchThread } =
    useThreadList({ filter, owner, q: query });
  const { counts, refresh: refreshCounts } = useInboxCounts();

  // Realtime refresh on any change in interactions / thread_state.
  const refreshAll = useCallback(() => {
    refresh();
    refreshCounts();
  }, [refresh, refreshCounts]);
  useInboxRealtime(refreshAll);

  // Apply deep link once threads load.
  useEffect(() => {
    if (consumedDeepLink.current) return;
    if (!deepLinkThreadId) return;
    if (threads.some(t => t.gmail_thread_id === deepLinkThreadId)) {
      setSelectedId(deepLinkThreadId);
      consumedDeepLink.current = true;
    } else if (threads.length > 0) {
      // Thread may not be in the current filter; select it anyway so the reader
      // loads it directly from the API.
      setSelectedId(deepLinkThreadId);
      consumedDeepLink.current = true;
    }
  }, [deepLinkThreadId, threads]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setComposerOpen(false);
  }, []);

  const composerFocusRef = useRef<() => void>(() => {});
  const registerFocusComposer = useCallback((fn: () => void) => {
    composerFocusRef.current = fn;
  }, []);
  const focusComposer = useCallback(() => {
    if (!selectedId) return;
    setComposerOpen(true);
    composerFocusRef.current();
  }, [selectedId]);

  // Local optimistic edits
  const handleArchivedLocal = useCallback(
    (threadId: string) => {
      patchThread(threadId, { archived_at: new Date().toISOString() });
      // If archived while in a non-archived folder, drop from selection.
      if (filter !== 'archived') {
        setSelectedId(null);
      }
    },
    [patchThread, filter]
  );

  const handleMarkUnreadLocal = useCallback(
    (threadId: string) => {
      patchThread(threadId, { is_unread: true });
    },
    [patchThread]
  );

  return (
    <div
      className="flex w-full overflow-hidden bg-[color:var(--bg)]"
      style={{ height: 'calc(100vh - var(--topnav-height))' }}
    >
      {/* Folder rail */}
      <aside
        className="flex-shrink-0 border-r border-[color:var(--border-subtle)] bg-white"
        style={{ width: 220 }}
      >
        <FolderRail
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
        />
        {/* Owner filter — simple segmented control */}
        <div className="px-2 pb-3">
          <div className="label-uppercase px-2 pb-1.5 pt-2">Owner</div>
          <div className="flex gap-1 px-1">
            {[
              { id: 'all', label: 'All' },
              { id: 'me', label: 'Me' },
            ].map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setOwner(opt.id)}
                className={
                  owner === opt.id
                    ? 'flex-1 text-[12px] px-2 py-1 rounded-md bg-gray-900 text-white'
                    : 'flex-1 text-[12px] px-2 py-1 rounded-md text-gray-600 hover:bg-gray-100'
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Middle: thread list */}
      <div
        className="flex-shrink-0 border-r border-[color:var(--border-subtle)] min-w-0"
        style={{ width: middleWidth }}
      >
        <div className="h-full min-h-0 flex flex-col">
          <ThreadList
            threads={threads}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            selectedId={selectedId}
            onSelect={handleSelect}
            filter={filter}
            query={query}
            onQueryChange={setQuery}
            onRefresh={refreshAll}
            onComposerFocus={focusComposer}
            patchThread={patchThread}
          />
        </div>
      </div>

      <ResizeHandle
        storageKey={MIDDLE_WIDTH_KEY}
        defaultWidth={360}
        minWidth={280}
        maxWidth={520}
        onResize={setMiddleWidth}
      />

      {/* Right: thread reader */}
      <div className="flex-1 min-w-0 flex">
        {selectedId ? (
          <ThreadReader
            key={selectedId}
            threadId={selectedId}
            composerOpen={composerOpen}
            onComposerOpenChange={setComposerOpen}
            onArchiveLocal={handleArchivedLocal}
            onMarkUnreadLocal={handleMarkUnreadLocal}
            onRefresh={refreshAll}
            registerFocusComposer={registerFocusComposer}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}
