import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

type LeadRef = {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_email: string | null;
  stage: string | null;
  owned_by: string | null;
};

type RawRow = {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: string;
  gmail_thread_id: string;
  gmail_message_id: string | null;
  lead: LeadRef | null;
  team_member: { id: string; name: string } | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { threadId } = await params;
  if (!threadId) {
    return NextResponse.json({ error: 'Missing threadId' }, { status: 400 });
  }

  const markReadParam = req.nextUrl.searchParams.get('mark_read');
  const markRead = markReadParam === null ? true : markReadParam !== 'false';

  const supabase = createAdminClient();

  const { data: rows, error } = await supabase
    .from('interactions')
    .select(
      `
      id, type, subject, body, summary, occurred_at, gmail_thread_id, gmail_message_id,
      lead:leads(id, contact_name, company_name, contact_email, stage, owned_by),
      team_member:team_members(id, name)
    `
    )
    .in('type', ['email_inbound', 'email_outbound'])
    .eq('gmail_thread_id', threadId)
    .order('occurred_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const typedRows = (rows || []) as unknown as RawRow[];
  if (typedRows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const latest = typedRows[0];
  const lead = typedRows.find(r => r.lead)?.lead ?? null;

  const messages = typedRows.map(r => ({
    id: r.id,
    type: r.type,
    subject: r.subject,
    body: r.body,
    summary: r.summary,
    occurred_at: r.occurred_at,
    team_member: r.team_member,
    gmail_message_id: r.gmail_message_id,
  }));

  // Fetch thread state
  const { data: stateRow } = await supabase
    .from('thread_state')
    .select('snoozed_until, archived_at')
    .eq('gmail_thread_id', threadId)
    .maybeSingle();

  // Mark-read side effect
  if (markRead) {
    await supabase
      .from('thread_read_state')
      .upsert(
        {
          gmail_thread_id: threadId,
          team_member_id: session.id,
          last_read_at: new Date().toISOString(),
        },
        { onConflict: 'gmail_thread_id,team_member_id' }
      );
  }

  return NextResponse.json({
    thread_id: threadId,
    latest_at: latest.occurred_at,
    latest_subject: latest.subject || '(no subject)',
    messages,
    lead,
    snoozed_until: stateRow?.snoozed_until ?? null,
    archived_at: stateRow?.archived_at ?? null,
  });
}
