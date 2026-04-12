import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { sendReplyInThread } from '@/lib/gmail/send';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { body, thread_id, subject, sender_member_id } = await req.json();
  if (!body?.trim()) return NextResponse.json({ error: 'Body required' }, { status: 400 });
  if (!thread_id) return NextResponse.json({ error: 'thread_id required' }, { status: 400 });

  // Use sender_member_id if provided (send-as-any-founder), fall back to session user
  const effectiveSenderId = sender_member_id || session.id;

  const supabase = createAdminClient();

  const [memberRes, leadRes] = await Promise.all([
    supabase.from('team_members').select('id, name, email, gmail_connected').eq('id', effectiveSenderId).single(),
    supabase.from('leads').select('contact_email, company_name').eq('id', id).single(),
  ]);

  if (!memberRes.data?.gmail_connected) {
    return NextResponse.json({ error: `${memberRes.data?.name || 'That founder'}'s Gmail is not connected` }, { status: 400 });
  }
  if (!leadRes.data) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
  if (!leadRes.data.contact_email) return NextResponse.json({ error: 'Lead has no email address' }, { status: 400 });

  const { data: lastInbound } = await supabase
    .from('interactions')
    .select('gmail_message_id')
    .eq('lead_id', id)
    .eq('gmail_thread_id', thread_id)
    .eq('type', 'email_inbound')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const inReplyToMessageId = lastInbound?.gmail_message_id ? `<${lastInbound.gmail_message_id}>` : undefined;
  const replySubject = subject || `product prioritization at ${leadRes.data.company_name}`;

  const sentMessageId = await sendReplyInThread({
    teamMemberId: effectiveSenderId,
    threadId: thread_id,
    to: leadRes.data.contact_email,
    subject: replySubject,
    body: body.trim(),
    inReplyToMessageId,
  });

  const now = new Date().toISOString();

  const { data: interaction, error } = await supabase
    .from('interactions')
    .insert({
      lead_id: id,
      team_member_id: effectiveSenderId,
      type: 'email_outbound',
      subject: replySubject.startsWith('Re:') ? replySubject : `Re: ${replySubject}`,
      body: body.trim(),
      gmail_message_id: sentMessageId || undefined,
      gmail_thread_id: thread_id,
      occurred_at: now,
      metadata: {
        manual_send: true,
        sent_by: session.id,
        sent_as: effectiveSenderId,
        cross_founder: effectiveSenderId !== session.id,
      },
    })
    .select('*, team_member:team_members(id, name)')
    .single();

  if (error) {
    console.error('Failed to log sent email interaction:', error.message);
    return NextResponse.json({ sent: true, interaction: null });
  }

  await supabase.from('leads').update({ last_contact_at: now }).eq('id', id);

  return NextResponse.json({ sent: true, interaction });
}
