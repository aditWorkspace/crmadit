'use client';

import { useCallback } from 'react';
import { useSession } from './use-session';

/**
 * Thin wrapper over POST/DELETE /api/inbox/threads/[id]/read.
 * POST → mark read (sets last_read_at = now)
 * DELETE → mark unread (clears the per-user read row)
 */
export function useThreadReadState() {
  const { user } = useSession();

  const markRead = useCallback(
    async (threadId: string) => {
      if (!user) return false;
      const res = await fetch(
        `/api/inbox/threads/${encodeURIComponent(threadId)}/read`,
        {
          method: 'POST',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      return res.ok;
    },
    [user]
  );

  const markUnread = useCallback(
    async (threadId: string) => {
      if (!user) return false;
      const res = await fetch(
        `/api/inbox/threads/${encodeURIComponent(threadId)}/read`,
        {
          method: 'DELETE',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      return res.ok;
    },
    [user]
  );

  const toggle = useCallback(
    async (threadId: string, currentlyUnread: boolean) => {
      return currentlyUnread ? markRead(threadId) : markUnread(threadId);
    },
    [markRead, markUnread]
  );

  return { markRead, markUnread, toggle };
}
