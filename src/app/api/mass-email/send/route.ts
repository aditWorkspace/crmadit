export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { sendBccEmail } from '@/lib/gmail/send';

const BATCH_SIZE = 80; // Gmail allows ~100 recipients per message; stay under

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { sender_member_id, lead_ids, subject, body, is_test, test_emails } = await req.json();

  if (!subject || !body) {
    return NextResponse.json({ error: 'subject and body are required' }, { status: 400 });
  }

  const senderId = sender_member_id || session.id;
  const supabase = createAdminClient();

  // Verify sender has Gmail connected
  const { data: sender } = await supabase
    .from('team_members')
    .select('id, name, gmail_connected')
    .eq('id', senderId)
    .single();

  if (!sender?.gmail_connected) {
    return NextResponse.json({ error: 'Sender does not have Gmail connected' }, { status: 400 });
  }

  // ── Test mode: send to test emails only ──────────────────────────────────
  if (is_test) {
    const emails = test_emails?.length ? test_emails : [session.email];
    try {
      await sendBccEmail({ teamMemberId: senderId, bccRecipients: emails, subject, body });
      return NextResponse.json({ success: true, sent: emails.length, failed: 0, mode: 'test' });
    } catch (err) {
      return NextResponse.json({ error: `Test send failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
    }
  }

  // ── Production mode: send to selected leads ──────────────────────────────
  if (!lead_ids?.length) {
    return NextResponse.json({ error: 'lead_ids required for production send' }, { status: 400 });
  }

  // Fetch contact emails for selected leads
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_email, contact_name, company_name')
    .in('id', lead_ids)
    .eq('is_archived', false);

  if (!leads?.length) {
    return NextResponse.json({ error: 'No valid leads found' }, { status: 400 });
  }

  // Deduplicate by email
  const emailToLead = new Map<string, typeof leads[0]>();
  for (const lead of leads) {
    if (lead.contact_email) {
      emailToLead.set(lead.contact_email.toLowerCase(), lead);
    }
  }

  const uniqueEmails = [...emailToLead.keys()];
  if (uniqueEmails.length === 0) {
    return NextResponse.json({ error: 'No leads have contact emails' }, { status: 400 });
  }

  // Split into batches and send
  const batchId = crypto.randomUUID();
  let totalSent = 0;
  let totalFailed = 0;
  const errors: string[] = [];
  const sentEmails = new Set<string>();

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    try {
      await sendBccEmail({ teamMemberId: senderId, bccRecipients: batch, subject, body });
      batch.forEach(e => sentEmails.add(e));
      totalSent += batch.length;
    } catch (err) {
      totalFailed += batch.length;
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Only log interactions for leads that were actually emailed (not failed batches)
  const now = new Date().toISOString();
  const sentLeads = [...emailToLead.entries()]
    .filter(([email]) => sentEmails.has(email))
    .map(([, lead]) => lead);

  const interactionInserts = sentLeads.map(lead => ({
    lead_id: lead.id,
    team_member_id: senderId,
    type: 'email_outbound' as const,
    subject,
    body: body.slice(0, 2000),
    occurred_at: now,
    metadata: { mass_email: true, batch_id: batchId, sent_by: session.id },
  }));

  // Insert all interactions
  await supabase.from('interactions').insert(interactionInserts);

  // Update last_contact_at only for successfully sent leads
  const leadIdsToUpdate = sentLeads.map(l => l.id);
  await supabase
    .from('leads')
    .update({ last_contact_at: now })
    .in('id', leadIdsToUpdate);

  // Log to activity_log
  await supabase.from('activity_log').insert({
    team_member_id: session.id,
    action: 'mass_email_sent',
    details: {
      batch_id: batchId,
      sender_id: senderId,
      sender_name: sender.name,
      subject,
      total_recipients: uniqueEmails.length,
      total_sent: totalSent,
      total_failed: totalFailed,
    },
  });

  return NextResponse.json({
    success: true,
    batch_id: batchId,
    sent: totalSent,
    failed: totalFailed,
    errors: errors.length ? errors : undefined,
  });
}
