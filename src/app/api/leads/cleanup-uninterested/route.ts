import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { classifyReplyIntent } from '@/lib/gmail/reply-classifier';

/**
 * POST /api/leads/cleanup-uninterested
 *
 * Scans all active leads in the 'replied' stage, checks the first inbound
 * email body, and archives leads where the prospect is clearly not interested.
 *
 * Pass ?dry_run=true to preview what would be archived without making changes.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dryRun = req.nextUrl.searchParams.get('dry_run') === 'true';
  const supabase = createAdminClient();

  // Find all active leads in 'replied' stage (most likely to contain uninterested replies)
  const { data: leads, error: fetchErr } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage')
    .eq('is_archived', false)
    .eq('stage', 'replied')
    .order('created_at', { ascending: false });

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!leads || leads.length === 0) {
    return NextResponse.json({ success: true, message: 'No replied-stage leads to check', archived: [] });
  }

  const archived: Array<{ id: string; contact_name: string; company_name: string; reason: string }> = [];
  const kept: Array<{ id: string; contact_name: string; company_name: string }> = [];

  for (const lead of leads) {
    // Get the first inbound email for this lead
    const { data: inboundEmails } = await supabase
      .from('interactions')
      .select('subject, body')
      .eq('lead_id', lead.id)
      .eq('type', 'email_inbound')
      .order('occurred_at', { ascending: true })
      .limit(1);

    if (!inboundEmails || inboundEmails.length === 0) {
      kept.push({ id: lead.id, contact_name: lead.contact_name, company_name: lead.company_name });
      continue;
    }

    const email = inboundEmails[0];
    // Delay between AI calls to respect free-tier rate limits
    await new Promise(r => setTimeout(r, 3000));
    const intent = await classifyReplyIntent(email.subject || '', email.body || '');

    if (intent === 'not_interested') {
      archived.push({
        id: lead.id,
        contact_name: lead.contact_name,
        company_name: lead.company_name,
        reason: `First reply not interested: "${(email.body || '').slice(0, 100)}..."`,
      });

      if (!dryRun) {
        await supabase
          .from('leads')
          .update({ stage: 'dead', is_archived: true, updated_at: new Date().toISOString() })
          .eq('id', lead.id);

        // Dismiss any pending follow-ups
        await supabase
          .from('follow_up_queue')
          .update({ status: 'dismissed', updated_at: new Date().toISOString() })
          .eq('lead_id', lead.id)
          .eq('status', 'pending');
      }
    } else {
      kept.push({ id: lead.id, contact_name: lead.contact_name, company_name: lead.company_name });
    }
  }

  return NextResponse.json({
    success: true,
    dry_run: dryRun,
    leads_checked: leads.length,
    archived_count: archived.length,
    kept_count: kept.length,
    archived,
  });
}
