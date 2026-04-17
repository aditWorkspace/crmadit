'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useSession } from './use-session';

export interface PresenceViewer {
  memberId: string;
  name: string;
}

interface PresenceMeta {
  member_id: string;
  name: string;
  viewing_thread: string | null;
  at: string;
}

export type InboxPresenceMap = Record<string, PresenceViewer[]>;

/**
 * Global inbox presence channel. Each inbox viewer publishes the thread they
 * are currently focused on (if any). Returns a map keyed by threadId with the
 * list of viewers (excluding self).
 *
 * Also emits `inbox:presence-update` CustomEvents on every change so non-React
 * consumers (e.g. a ThreadList row managed by a sibling lane) can subscribe
 * without direct hook access.
 */
export function useInboxPresence(viewingThreadId: string | null) {
  const { user } = useSession();
  const supabase = useMemo(() => createClient(), []);
  const [presence, setPresence] = useState<InboxPresenceMap>({});
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const viewingRef = useRef<string | null>(null);
  viewingRef.current = viewingThreadId;

  // Mount: create the channel once per user.
  useEffect(() => {
    if (!user) return;
    const channel = supabase.channel('inbox:presence', {
      config: { presence: { key: user.team_member_id } },
    });
    channelRef.current = channel;

    const syncFromState = () => {
      const state = channel.presenceState<PresenceMeta>();
      const next: InboxPresenceMap = {};
      for (const key of Object.keys(state)) {
        const entries = state[key];
        if (!entries || entries.length === 0) continue;
        const first = entries[0];
        if (!first) continue;
        if (first.member_id === user.team_member_id) continue;
        const tid = first.viewing_thread;
        if (!tid) continue;
        if (!next[tid]) next[tid] = [];
        next[tid].push({ memberId: first.member_id, name: first.name });
      }
      setPresence(prev => {
        // Emit per-thread update events for threads whose viewer set changed.
        const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const tid of allKeys) {
          const before = prev[tid] ?? [];
          const after = next[tid] ?? [];
          if (
            before.length !== after.length ||
            before.map(v => v.memberId).sort().join(',') !==
              after.map(v => v.memberId).sort().join(',')
          ) {
            try {
              window.dispatchEvent(
                new CustomEvent('inbox:presence-update', {
                  detail: { threadId: tid, viewers: after },
                })
              );
            } catch {
              /* ignore */
            }
          }
        }
        return next;
      });
    };

    channel
      .on('presence', { event: 'sync' }, syncFromState)
      .on('presence', { event: 'join' }, syncFromState)
      .on('presence', { event: 'leave' }, syncFromState)
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            member_id: user.team_member_id,
            name: user.name,
            viewing_thread: viewingRef.current,
            at: new Date().toISOString(),
          } satisfies PresenceMeta);
        }
      });

    return () => {
      try {
        void channel.untrack();
      } catch {
        /* ignore */
      }
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [supabase, user]);

  // Re-track whenever the viewer switches threads.
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !user) return;
    void channel.track({
      member_id: user.team_member_id,
      name: user.name,
      viewing_thread: viewingThreadId,
      at: new Date().toISOString(),
    } satisfies PresenceMeta);
  }, [user, viewingThreadId]);

  return { presence };
}

/**
 * Convenience hook for ThreadList rows that live outside this hook's React
 * tree: subscribes to DOM events dispatched by `useInboxPresence` and
 * exposes the current viewers for a single threadId.
 */
export function useInboxPresenceViewers(threadId: string | null) {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  useEffect(() => {
    if (!threadId) {
      setViewers([]);
      return;
    }
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<{
        threadId: string;
        viewers: PresenceViewer[];
      }>;
      if (!e.detail) return;
      if (e.detail.threadId !== threadId) return;
      setViewers(e.detail.viewers ?? []);
    };
    window.addEventListener('inbox:presence-update', handler as EventListener);
    return () =>
      window.removeEventListener(
        'inbox:presence-update',
        handler as EventListener
      );
  }, [threadId]);
  return { viewers, isViewed: viewers.length > 0 };
}
