'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from './use-session';
import type { InboxFilter } from './use-inbox-counts';

export interface InboxLeadRef {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_email: string | null;
  stage: string | null;
  owned_by: string | null;
}

export interface InboxThread {
  /** Gmail thread id — primary key for all row actions. */
  gmail_thread_id: string;
  subject: string;
  snippet: string;
  last_message_at: string;
  owner_member_id: string | null;
  owner_name: string | null;
  lead_id: string | null;
  lead_stage: string | null;
  lead_contact_name: string | null;
  lead_company_name: string | null;
  lead_contact_email: string | null;
  is_unread: boolean;
  message_count: number;
  snoozed_until: string | null;
  archived_at: string | null;
  latest_type: string;
  lead: InboxLeadRef | null;
}

/**
 * The thread-list API returns a shape that differs slightly from the Lane D spec
 * (e.g. uses `thread_id` and `latest_at` instead of `gmail_thread_id` / `last_message_at`,
 * and nests the lead). We normalize once here so downstream UI is stable.
 */
interface RawThread {
  thread_id: string;
  latest_at: string;
  latest_subject: string;
  latest_type: string;
  message_count: number;
  inbound_count: number;
  is_unread: boolean;
  snoozed_until: string | null;
  archived_at: string | null;
  lead: InboxLeadRef | null;
  messages?: Array<{
    id: string;
    type: string;
    subject: string | null;
    body: string | null;
    summary: string | null;
    occurred_at: string;
    team_member: { id: string; name: string } | null;
  }>;
}

function normalize(raw: RawThread, ownerNameById: Map<string, string>): InboxThread {
  const first = raw.messages?.[0];
  const snippetSource = first?.summary || first?.body || '';
  const snippet = snippetSource.replace(/\s+/g, ' ').trim().slice(0, 200);
  const ownerId = raw.lead?.owned_by ?? null;
  return {
    gmail_thread_id: raw.thread_id,
    subject: raw.latest_subject || '(no subject)',
    snippet,
    last_message_at: raw.latest_at,
    owner_member_id: ownerId,
    owner_name: ownerId ? ownerNameById.get(ownerId) ?? null : null,
    lead_id: raw.lead?.id ?? null,
    lead_stage: raw.lead?.stage ?? null,
    lead_contact_name: raw.lead?.contact_name ?? null,
    lead_company_name: raw.lead?.company_name ?? null,
    lead_contact_email: raw.lead?.contact_email ?? null,
    is_unread: !!raw.is_unread,
    message_count: raw.message_count,
    snoozed_until: raw.snoozed_until,
    archived_at: raw.archived_at,
    latest_type: raw.latest_type,
    lead: raw.lead,
  };
}

export interface UseThreadListOptions {
  filter: InboxFilter;
  owner: string; // 'all' | 'me' | '<uuid>'
  q?: string;
  limit?: number;
}

export function useThreadList(opts: UseThreadListOptions) {
  const { user } = useSession();
  const { filter, owner, q = '', limit = 40 } = opts;

  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const ownerMapRef = useRef<Map<string, string>>(new Map());
  const fetchSeqRef = useRef(0);

  // Keep an owner-name map so thread rows can display who owns a lead.
  // Refreshed from /api/team/members (no auth required for the public list).
  useEffect(() => {
    let cancel = false;
    fetch('/api/team/members')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancel || !data?.members) return;
        const map = new Map<string, string>();
        for (const m of data.members as Array<{ id: string; name: string }>) {
          map.set(m.id, m.name);
        }
        ownerMapRef.current = map;
        // Re-stamp any already-loaded threads with names
        setThreads(prev =>
          prev.map(t =>
            t.owner_member_id
              ? { ...t, owner_name: map.get(t.owner_member_id) ?? t.owner_name }
              : t
          )
        );
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, []);

  const runFetch = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!user) return;
      const seq = ++fetchSeqRef.current;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('filter', filter);
        params.set('owner', owner);
        if (q) params.set('q', q);
        if (cursor) params.set('cursor', cursor);
        params.set('limit', String(limit));

        const res = await fetch(`/api/inbox/threads?${params.toString()}`, {
          headers: { 'x-team-member-id': user.team_member_id },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          threads: RawThread[];
          next_cursor: string | null;
        };
        if (seq !== fetchSeqRef.current) return; // stale
        const normalized = (data.threads || []).map(t =>
          normalize(t, ownerMapRef.current)
        );
        setThreads(prev => (append ? [...prev, ...normalized] : normalized));
        setNextCursor(data.next_cursor);
        setHasMore(!!data.next_cursor);
      } catch {
        /* non-fatal */
      } finally {
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [user, filter, owner, q, limit]
  );

  // Initial + on-filter-change load
  useEffect(() => {
    setThreads([]);
    setNextCursor(null);
    setHasMore(false);
    runFetch(null, false);
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loading) return;
    runFetch(nextCursor, true);
  }, [nextCursor, loading, runFetch]);

  const refresh = useCallback(() => {
    runFetch(null, false);
  }, [runFetch]);

  const patchThread = useCallback(
    (id: string, delta: Partial<InboxThread>) => {
      setThreads(prev =>
        prev.map(t => (t.gmail_thread_id === id ? { ...t, ...delta } : t))
      );
    },
    []
  );

  return { threads, loading, hasMore, loadMore, refresh, patchThread };
}
