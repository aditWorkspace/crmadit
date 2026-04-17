'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from './use-session';

export type InboxFilter =
  | 'needs_response'
  | 'all'
  | 'sent'
  | 'snoozed'
  | 'archived'
  | 'unread';

export type InboxCounts = Record<InboxFilter, number>;

const ZERO: InboxCounts = {
  needs_response: 0,
  all: 0,
  sent: 0,
  snoozed: 0,
  archived: 0,
  unread: 0,
};

export function useInboxCounts() {
  const { user } = useSession();
  const [counts, setCounts] = useState<InboxCounts>(ZERO);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await fetch('/api/inbox/counts', {
        headers: { 'x-team-member-id': user.team_member_id },
      });
      if (res.ok) {
        const data = (await res.json()) as Partial<InboxCounts>;
        setCounts({
          needs_response: data.needs_response ?? 0,
          all: data.all ?? 0,
          sent: data.sent ?? 0,
          snoozed: data.snoozed ?? 0,
          archived: data.archived ?? 0,
          unread: data.unread ?? 0,
        });
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Revalidate on window focus
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refresh]);

  return { counts, loading, refresh };
}
