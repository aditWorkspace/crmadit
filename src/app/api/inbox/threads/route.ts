import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

type Filter = 'needs_response' | 'all' | 'sent' | 'snoozed' | 'archived' | 'unread';

const VALID_FILTERS: readonly Filter[] = [
  'needs_response',
  'all',
  'sent',
  'snoozed',
  'archived',
  'unread',
] as const;

type LeadRef = {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_email: string | null;
  stage: string | null;
  owned_by: string | null;
};

type TeamMemberRef = { id: string; name: string } | null;

type RawEmailRow = {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: string;
  gmail_thread_id: string;
  gmail_message_id: string | null;
  lead: LeadRef | null;
  team_member: TeamMemberRef;
};

type ThreadMessage = {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: string;
  team_member: TeamMemberRef;
  gmail_message_id: string | null;
};

type ThreadAgg = {
  thread_id: string;
  latest_at: string;
  latest_subject: string;
  latest_type: string;
  message_count: number;
  inbound_count: number;
  is_unread: boolean;
  snoozed_until: string | null;
  archived_at: string | null;
  lead: LeadRef | null;
  messages: ThreadMessage[];
};

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const rawFilter = (searchParams.get('filter') || 'needs_response') as Filter;
  const filter: Filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : 'needs_response';
  const ownerParam = searchParams.get('owner') || 'all';
  const q = searchParams.get('q')?.trim() || '';
  const cursor = searchParams.get('cursor');
  const rawLimit = parseInt(searchParams.get('limit') || '40', 10);
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 40, 100));

  const ownerId =
    ownerParam === 'me' ? session.id : ownerParam === 'all' ? null : ownerParam;

  const supabase = createAdminClient();

  // Pull a generous window of recent email interactions, grouped into threads below.
  // Cap at 500 rows — with 3 users + a few hundred threads this is safe.
  const fetchLimit = Math.min(limit * 5, 500);

  const { data: emails, error } = await supabase
    .from('interactions')
    .select(
      `
      id, type, subject, body, summary, occurred_at, gmail_thread_id, gmail_message_id,
      lead:leads!inner(id, contact_name, company_name, contact_email, stage, owned_by),
      team_member:team_members(id, name)
    `
    )
    .in('type', ['email_inbound', 'email_outbound'])
    .not('gmail_thread_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (emails || []) as unknown as RawEmailRow[];

  // Group by thread id
  const threadMap = new Map<string, ThreadAgg>();
  for (const row of rows) {
    const tid = row.gmail_thread_id;
    if (!tid) continue;

    let thread = threadMap.get(tid);
    if (!thread) {
      thread = {
        thread_id: tid,
        latest_at: row.occurred_at,
        latest_subject: row.subject || '(no subject)',
        latest_type: row.type,
        message_count: 0,
        inbound_count: 0,
        is_unread: false,
        snoozed_until: null,
        archived_at: null,
        lead: row.lead,
        messages: [],
      };
      threadMap.set(tid, thread);
    }

    thread.message_count++;
    if (row.type === 'email_inbound') thread.inbound_count++;
    if (thread.messages.length < 20) {
      thread.messages.push({
        id: row.id,
        type: row.type,
        subject: row.subject,
        body: row.body,
        summary: row.summary,
        occurred_at: row.occurred_at,
        team_member: row.team_member,
        gmail_message_id: row.gmail_message_id,
      });
    }
  }

  const threadIds = Array.from(threadMap.keys());

  // Left-join thread_state for these thread ids
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
  }

  // Left-join read state for the current user
  if (threadIds.length > 0) {
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
  } else {
    for (const t of threadMap.values()) {
      t.is_unread = t.latest_type === 'email_inbound';
    }
  }

  const nowMs = Date.now();

  // Apply filters
  let threads = Array.from(threadMap.values()).filter(t => {
    const isSnoozed = t.snoozed_until && new Date(t.snoozed_until).getTime() > nowMs;
    const isArchived = !!t.archived_at;

    switch (filter) {
      case 'needs_response':
        return t.latest_type === 'email_inbound' && !isSnoozed && !isArchived;
      case 'sent':
        return t.latest_type === 'email_outbound' && !isArchived;
      case 'snoozed':
        return !!isSnoozed;
      case 'archived':
        return isArchived;
      case 'unread':
        return t.is_unread && !isArchived;
      case 'all':
      default:
        return !isArchived;
    }
  });

  // Owner filter
  if (ownerId) {
    threads = threads.filter(t => t.lead?.owned_by === ownerId);
  }

  // Search q: ilike-style case-insensitive substring match
  if (q) {
    const needle = q.toLowerCase();
    threads = threads.filter(t => {
      const name = t.lead?.contact_name?.toLowerCase() || '';
      const company = t.lead?.company_name?.toLowerCase() || '';
      const subject = t.latest_subject.toLowerCase();
      return name.includes(needle) || company.includes(needle) || subject.includes(needle);
    });
  }

  // Cursor: latest_at < cursor
  if (cursor) {
    const cursorMs = new Date(cursor).getTime();
    if (Number.isFinite(cursorMs)) {
      threads = threads.filter(t => new Date(t.latest_at).getTime() < cursorMs);
    }
  }

  // Sort: unread first, then latest_at desc
  threads.sort((a, b) => {
    if (a.is_unread !== b.is_unread) return a.is_unread ? -1 : 1;
    return new Date(b.latest_at).getTime() - new Date(a.latest_at).getTime();
  });

  const page = threads.slice(0, limit);
  const nextCursor =
    page.length === limit && threads.length > limit ? page[page.length - 1].latest_at : null;

  return NextResponse.json({ threads: page, next_cursor: nextCursor });
}
