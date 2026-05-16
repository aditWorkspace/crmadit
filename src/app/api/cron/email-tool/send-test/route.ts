// POST /api/cron/email-tool/send-test — one-off test sender.
//
// Used to fire N real production-quality emails from a specific founder
// against the top of the live email_pool, so a human can verify the
// rendering before the scheduled 7:30am PT campaign drains hundreds
// of rows. Standard production flow: picks via email_tool_pick_batch,
// inserts into email_send_queue, calls sendCampaignEmail, then claims
// the picked emails so tomorrow's campaign won't re-pick them.
//
// Auth: CRON_SECRET Bearer.
//
// Query / body params:
//   founder    — "Adit" | "Asim" (case-insensitive)
//   count      — integer 1..20 (default 5)
//
// Example:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "$URL/api/cron/email-tool/send-test?founder=Adit&count=5"

export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCampaignGmailClient } from '@/lib/gmail/client';
import { sendCampaignEmail } from '@/lib/email-tool/send';
import { log } from '@/lib/email-tool/log';

interface PickedRow {
  email: string;
  first_name: string | null;
  company: string | null;
  sequence: number;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const founderName = (url.searchParams.get('founder') ?? '').trim();
  const countParam = Number(url.searchParams.get('count') ?? '5');
  const count = Math.max(1, Math.min(20, Math.floor(countParam)));
  if (!founderName) {
    return NextResponse.json({ error: 'missing_founder' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1. Resolve founder.
  const { data: founderRow } = await supabase
    .from('team_members')
    .select('id, name, email')
    .ilike('name', founderName)
    .is('departed_at', null)
    .maybeSingle();
  if (!founderRow) {
    return NextResponse.json({ error: 'founder_not_found', founder: founderName }, { status: 404 });
  }
  const founder = founderRow as { id: string; name: string; email: string };

  // 2. Active fresh variants for this founder. Pick the first one — the
  // test is about rendering, not A/B selection.
  const { data: variantData } = await supabase
    .from('email_template_variants')
    .select('id, subject_template, body_template')
    .eq('founder_id', founder.id)
    .eq('is_active', true)
    .eq('is_followup', false)
    .order('id', { ascending: true })
    .limit(1);
  const variant = (variantData ?? [])[0] as
    | { id: string; subject_template: string; body_template: string }
    | undefined;
  if (!variant) {
    return NextResponse.json({ error: 'no_active_variant', founder: founder.name }, { status: 500 });
  }

  // 3. Pick top N rows from the pool. Same RPC the scheduled campaign uses.
  const { data: picked, error: pickErr } = await supabase.rpc('email_tool_pick_batch', { p_limit: count });
  if (pickErr) {
    return NextResponse.json({ error: 'pick_failed', detail: pickErr.message }, { status: 500 });
  }
  const rows = (picked ?? []) as PickedRow[];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'pool_empty' }, { status: 500 });
  }

  // 4. Create a test campaign row so the queue inserts have a valid FK.
  const idempotencyKey = `test-${Date.now()}`;
  const { data: campaignIns, error: campaignErr } = await supabase
    .from('email_send_campaigns')
    .insert({
      idempotency_key: idempotencyKey,
      scheduled_for: new Date().toISOString(),
      started_at: new Date().toISOString(),
      status: 'running',
      send_mode: 'production',
      warmup_day: 99, // sentinel for "test"
      total_picked: rows.length,
    })
    .select('id')
    .single();
  if (campaignErr || !campaignIns) {
    return NextResponse.json({ error: 'campaign_insert_failed', detail: campaignErr?.message }, { status: 500 });
  }
  const campaignId = campaignIns.id as string;

  // 5. Insert queue rows.
  const queueRows = rows.map(r => ({
    campaign_id: campaignId,
    account_id: founder.id,
    recipient_email: r.email.toLowerCase(),
    recipient_name: r.first_name,
    recipient_company: r.company,
    template_variant_id: variant.id,
    send_at: new Date().toISOString(),
    source: 'pool' as const,
    priority_id: null,
    status: 'pending' as const,
  }));
  const { data: queueIns, error: queueErr } = await supabase
    .from('email_send_queue')
    .insert(queueRows)
    .select('id, recipient_email, recipient_name, recipient_company, send_at, template_variant_id, account_id, status');
  if (queueErr || !queueIns) {
    return NextResponse.json({ error: 'queue_insert_failed', detail: queueErr?.message }, { status: 500 });
  }

  // 6. Send each via Gmail.
  const gmail = await getCampaignGmailClient(founder.id);
  const results: Array<{ to: string; outcome: string; subject?: string; error?: string }> = [];
  let sentOk = 0;
  for (const q of queueIns as Array<{
    id: string; account_id: string; recipient_email: string;
    recipient_name: string | null; recipient_company: string | null;
    template_variant_id: string; send_at: string; status: 'pending';
  }>) {
    const outcome = await sendCampaignEmail(
      {
        queueRow: q,
        variant: { subject_template: variant.subject_template, body_template: variant.body_template },
        founder,
        sendMode: 'production',
        allowlist: [],
      },
      gmail,
    );
    if (outcome.outcome === 'sent') {
      sentOk++;
      await supabase
        .from('email_send_queue')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          gmail_message_id: outcome.gmail_message_id,
          gmail_thread_id: outcome.gmail_thread_id,
          rendered_subject: outcome.rendered_subject,
          rendered_body: outcome.rendered_body,
        })
        .eq('id', q.id);
      results.push({ to: q.recipient_email, outcome: 'sent', subject: outcome.rendered_subject });
    } else {
      await supabase
        .from('email_send_queue')
        .update({
          status: 'failed',
          last_error: 'last_error' in outcome ? outcome.last_error : outcome.outcome,
        })
        .eq('id', q.id);
      results.push({
        to: q.recipient_email,
        outcome: outcome.outcome,
        error: 'last_error' in outcome ? outcome.last_error : undefined,
      });
    }
    // Small jitter so the small batch doesn't look like a millisecond burst.
    await new Promise(res => setTimeout(res, 800));
  }

  // 7. Claim the picked emails so tomorrow's campaign can't re-pick them.
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.sequence), -1);
  const { error: claimErr } = await supabase.rpc('email_send_pool_claim_batch', {
    p_picked_emails: rows.map(r => r.email.toLowerCase()),
    p_max_sequence: maxSeq,
    p_campaign_id: campaignId,
  });
  if (claimErr) {
    log('error', 'send_test_claim_failed', { campaign_id: campaignId, err: claimErr.message });
  }

  // 8. Close out the campaign.
  await supabase
    .from('email_send_campaigns')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      total_sent: sentOk,
      total_failed: results.length - sentOk,
    })
    .eq('id', campaignId);

  return NextResponse.json({
    ok: true,
    campaign_id: campaignId,
    founder: founder.name,
    sent: sentOk,
    failed: results.length - sentOk,
    results,
  });
}
