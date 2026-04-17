'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useSession } from './use-session';

export interface ThreadViewer {
  memberId: string;
  name: string;
  at: string;
}

interface PresenceMeta {
  member_id: string;
  name: string;
  viewing_thread: string;
  at: string;
}

/**
 * Subscribe to a per-thread presence channel `thread:<threadId>`.
 * Tracks this user's presence while mounted; returns the list of OTHER
 * viewers currently on the same thread.
 */
export function useThreadPresence(threadId: string | null) {
  const { user } = useSession();
  const supabase = useMemo(() => createClient(), []);
  const [viewers, setViewers] = useState<ThreadViewer[]>([]);

  useEffect(() => {
    if (!user || !threadId) {
      setViewers([]);
      return;
    }

    const channelName = `thread:${threadId}`;
    const channel = supabase.channel(channelName, {
      config: { presence: { key: user.team_member_id } },
    });

    const syncViewers = () => {
      const state = channel.presenceState<PresenceMeta>();
      const next: ThreadViewer[] = [];
      for (const key of Object.keys(state)) {
        const entries = state[key];
        if (!entries || entries.length === 0) continue;
        // Use the most recent entry per member
        const first = entries[0];
        if (!first || first.member_id === user.team_member_id) continue;
        next.push({
          memberId: first.member_id,
          name: first.name,
          at: first.at,
        });
      }
      setViewers(next);
    };

    channel
      .on('presence', { event: 'sync' }, syncViewers)
      .on('presence', { event: 'join' }, syncViewers)
      .on('presence', { event: 'leave' }, syncViewers)
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            member_id: user.team_member_id,
            name: user.name,
            viewing_thread: threadId,
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
    };
  }, [supabase, user, threadId]);

  return { viewers };
}
