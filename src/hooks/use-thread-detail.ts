'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from './use-session';

export interface ThreadDetailMessage {
  id: string;
  type: 'email_inbound' | 'email_outbound' | string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: string;
  gmail_message_id: string | null;
  team_member: { id: string; name: string } | null;
}

export interface ThreadDetailLead {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_email: string | null;
  stage: string | null;
  owned_by: string | null;
}

export interface ThreadDetail {
  thread_id: string;
  latest_at: string;
  latest_subject: string;
  messages: ThreadDetailMessage[];
  lead: ThreadDetailLead | null;
  snoozed_until: string | null;
  archived_at: string | null;
}

export function useThreadDetail(threadId: string | null) {
  const { user } = useSession();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const fetchDetail = useCallback(
    async (markRead: boolean) => {
      if (!user || !threadId) {
        setDetail(null);
        return;
      }
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const url = `/api/inbox/threads/${encodeURIComponent(threadId)}${
          markRead ? '' : '?mark_read=false'
        }`;
        const res = await fetch(url, {
          headers: { 'x-team-member-id': user.team_member_id },
        });
        if (!res.ok) {
          setError('Failed to load thread');
          setDetail(null);
          return;
        }
        const data = (await res.json()) as ThreadDetail;
        if (seq !== seqRef.current) return;
        setDetail(data);
      } catch {
        setError('Failed to load thread');
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [user, threadId]
  );

  // Fetch on thread change; default mark_read=true (API default).
  useEffect(() => {
    fetchDetail(true);
  }, [fetchDetail]);

  const refresh = useCallback(() => {
    fetchDetail(false);
  }, [fetchDetail]);

  return { detail, loading, error, refresh };
}
