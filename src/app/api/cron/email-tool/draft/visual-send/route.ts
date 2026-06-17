// POST — send ONE ready visual draft right now from the dashboard. Builds a
// real email_send_queue row and drains it through runTick, so the send goes
// through the exact production path (blacklist / unsubscribe / domain-once
// checks, send-mode gating, tracking pixel, logging) — just human-triggered
// instead of the morning scheduler. Admin-only.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { runTick } from '@/lib/email-tool/tick';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

const MANUAL_CAMPAIGN_KEY = 'manual-dashboard';

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from('cold_email_drafts')
    .select('id, status, email, first_name, company, sender_account_id, subject, body, email_html, image_url')
    .eq('id', id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const d = draft as {
    id: string; status: string; email: string; first_name: string | null; company: string | null;
    sender_account_id: string; subject: string | null; body: string | null; email_html: string | null; image_url: string | null;
  };
  if (d.status !== 'ready') return NextResponse.json({ error: `draft is '${d.status}', not ready` }, { status: 400 });
  if (!d.email_html) return NextResponse.json({ error: 'draft has no email_html' }, { status: 400 });

  // Inactive sentinel variant for the sender (only satisfies the queue's
  // NOT-NULL template_variant_id FK; the personalized snapshot wins at send).
  const { data: sentinel } = await supabase
    .from('email_template_variants')
    .select('id')
    .eq('founder_id', d.sender_account_id)
    .eq('is_active', false)
    .ilike('label', '%sentinel%')
    .maybeSingle();
  if (!sentinel) return NextResponse.json({ error: 'no sentinel variant for sender' }, { status: 400 });

  const nowIso = new Date().toISOString();

  // Persistent "manual" campaign (terminal status so the orphan sweep ignores it).
  let { data: campaign } = await supabase.from('email_send_campaigns').select('id').eq('idempotency_key', MANUAL_CAMPAIGN_KEY).maybeSingle();
  if (!campaign) {
    const ins = await supabase.from('email_send_campaigns').insert({
      idempotency_key: MANUAL_CAMPAIGN_KEY, status: 'done', scheduled_for: nowIso, started_at: nowIso, completed_at: nowIso,
      send_mode: 'production', warmup_day: 0, total_picked: 0, total_sent: 0, total_failed: 0, total_skipped: 0,
    }).select('id').single();
    campaign = ins.data;
  }
  if (!campaign) return NextResponse.json({ error: 'could not create manual campaign' }, { status: 500 });

  const { data: qrow, error: qerr } = await supabase.from('email_send_queue').insert({
    campaign_id: campaign.id, account_id: d.sender_account_id,
    recipient_email: d.email, recipient_name: d.first_name, recipient_company: d.company,
    template_variant_id: sentinel.id, send_at: nowIso, status: 'pending', source: 'pool',
    personalized_draft_id: d.id, personalized_subject: d.subject, personalized_body: d.body,
    personalized_html: d.email_html, image_url: d.image_url,
  }).select('id').single();
  if (qerr || !qrow) return NextResponse.json({ error: 'enqueue failed', detail: qerr?.message }, { status: 500 });

  await supabase.from('cold_email_drafts')
    .update({ status: 'consumed', consumed_at: nowIso, campaign_id: campaign.id })
    .eq('id', id);

  // Drain — runTick sends due rows via the full safety path.
  const stats = await runTick(supabase);

  const { data: after } = await supabase
    .from('email_send_queue')
    .select('status, gmail_message_id, last_error')
    .eq('id', qrow.id)
    .maybeSingle();
  const a = after as { status: string; gmail_message_id: string | null; last_error: string | null } | null;
  return NextResponse.json({
    ok: a?.status === 'sent',
    queue_status: a?.status ?? 'unknown',
    gmail_message_id: a?.gmail_message_id ?? null,
    last_error: a?.last_error ?? null,
    tick: stats,
  });
}
