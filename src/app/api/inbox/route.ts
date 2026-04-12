import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const owner = req.nextUrl.searchParams.get('owner');

  // Fetch recent email interactions (both inbound + outbound) for threading
  let query = supabase
    .from('interactions')
    .select(`
      id, type, subject, body, summary, occurred_at, gmail_thread_id,
      lead:leads!inner(id, contact_name, company_name, contact_email, stage, owned_by),
      team_member:team_members(id, name)
    `)
    .in('type', ['email_inbound', 'email_outbound'])
    .not('gmail_thread_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(200);

  if (owner) {
    query = query.eq('lead.owned_by', owner);
  }

  const { data: emails } = await query;

  // Group by gmail_thread_id, compute needs_reply
  const threadMap = new Map<string, {
    thread_id: string;
    latest_at: string;
    latest_subject: string;
    latest_type: string;
    needs_reply: boolean;
    message_count: number;
    inbound_count: number;
    lead: unknown;
    messages: unknown[];
  }>();

  for (const email of emails || []) {
    const tid = email.gmail_thread_id!;
    if (!threadMap.has(tid)) {
      threadMap.set(tid, {
        thread_id: tid,
        latest_at: email.occurred_at,
        latest_subject: email.subject || '(no subject)',
        latest_type: email.type,
        needs_reply: email.type === 'email_inbound',
        message_count: 0,
        inbound_count: 0,
        lead: email.lead,
        messages: [],
      });
    }
    const thread = threadMap.get(tid)!;
    thread.message_count++;
    if (email.type === 'email_inbound') thread.inbound_count++;
    thread.messages.push({
      id: email.id,
      type: email.type,
      subject: email.subject,
      body: email.body,
      summary: email.summary,
      occurred_at: email.occurred_at,
      team_member: email.team_member,
    });
  }

  const threads = Array.from(threadMap.values())
    .sort((a, b) => {
      // needs_reply first, then by recency
      if (a.needs_reply !== b.needs_reply) return a.needs_reply ? -1 : 1;
      return new Date(b.latest_at).getTime() - new Date(a.latest_at).getTime();
    });

  return NextResponse.json({ threads });
}
