import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

type RawRow = {
  id: string;
  type: string;
  occurred_at: string;
  gmail_thread_id: string;
  metadata: { triage?: { needs_response?: boolean } } | null;
};

type ThreadSummary = {
  thread_id: string;
  latest_at: string;
  latest_type: string;
  latest_needs_response: boolean;
  snoozed_until: string | null;
  archived_at: string | null;
  is_unread: boolean;
};

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Pull a generous window; this endpoint is used for the folder rail and
  // doesn't need to be perfectly precise past the most recent ~500 messages.
  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, type, occurred_at, gmail_thread_id, metadata')
    .in('type', ['email_inbound', 'email_outbound'])
    .not('gmail_thread_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const typed = (rows || []) as unknown as RawRow[];
  const threadMap = new Map<string, ThreadSummary>();
  for (const r of typed) {
    if (!r.gmail_thread_id) continue;
    if (threadMap.has(r.gmail_thread_id)) continue;
    // Because rows are sorted DESC by occurred_at, the first row per thread is the latest.
    // First row per thread is the latest (rows arrive DESC). Fail-open:
    // unclassified inbound defaults to needs_response=true.
    const triage = r.metadata?.triage;
    const isInbound = r.type === 'email_inbound';
    threadMap.set(r.gmail_thread_id, {
      thread_id: r.gmail_thread_id,
      latest_at: r.occurred_at,
      latest_type: r.type,
      latest_needs_response: isInbound
        ? typeof triage?.needs_response === 'boolean'
          ? triage.needs_response
          : true
        : true,
      snoozed_until: null,
      archived_at: null,
      is_unread: false,
    });
  }

  const threadIds = Array.from(threadMap.keys());

  if (threadIds.length > 0) {
    const { data: states } = await supabase
      .from('thread_state')
      .select('gmail_thread_id, snoozed_until, archived_at')
      .in('gmail_thread_id', threadIds);
    for (const s of states || []) {
      const t = threadMap.get(s.gmail_thread_id as string);
      if (t) {
        t.snoozed_until = (s.snoozed_until as string | null) ?? null;
        t.archived_at = (s.archived_at as string | null) ?? null;
      }
    }

    const { data: reads } = await supabase
      .from('thread_read_state')
      .select('gmail_thread_id, last_read_at')
      .eq('team_member_id', session.id)
      .in('gmail_thread_id', threadIds);
    const readMap = new Map<string, string>();
    for (const r of reads || []) {
      readMap.set(r.gmail_thread_id as string, r.last_read_at as string);
    }
    for (const t of threadMap.values()) {
      const lastRead = readMap.get(t.thread_id);
      const lastReadMs = lastRead ? new Date(lastRead).getTime() : 0;
      const latestMs = new Date(t.latest_at).getTime();
      t.is_unread = (!lastRead || lastReadMs < latestMs) && t.latest_type === 'email_inbound';
    }
  }

  const nowMs = Date.now();
  const counts = {
    needs_response: 0,
    all: 0,
    sent: 0,
    snoozed: 0,
    archived: 0,
    unread: 0,
  };

  for (const t of threadMap.values()) {
    const isSnoozed = t.snoozed_until && new Date(t.snoozed_until).getTime() > nowMs;
    const isArchived = !!t.archived_at;

    if (isArchived) counts.archived++;
    if (isSnoozed) counts.snoozed++;

    if (!isArchived) counts.all++;
    if (
      t.latest_type === 'email_inbound' &&
      t.latest_needs_response &&
      !isSnoozed &&
      !isArchived
    ) {
      counts.needs_response++;
    }
    if (t.latest_type === 'email_outbound' && !isArchived) counts.sent++;
    if (t.is_unread && !isArchived) counts.unread++;
  }

  return NextResponse.json(counts);
}
