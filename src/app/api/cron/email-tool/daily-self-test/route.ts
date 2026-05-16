// POST /api/cron/email-tool/daily-self-test — nightly QA email to Adit.
//
// Fires once a day at 8 PM PT (cron-job.org). Sends one rendered
// template email to one of Adit's three personal Gmail inboxes,
// rotating deterministically by day-of-year so each inbox gets it
// every third day. Template merge values are fixed for visual QA:
//   first_name = "Adit"
//   company    = "Adit Testing"
// — so the rendered subject reads "pm workflow at Adit Testing" etc.
// If anything looks broken (subject substitution wrong, font weird,
// signoff missing) Adit notices immediately and can fix before the
// next morning's 7:30 AM PT campaign drains hundreds of real sends.
//
// Does NOT touch email_pool, email_blacklist, or email_send_queue —
// this is a side-channel test, not a campaign step. Logged as a one-
// off interaction so we can still audit which template+recipient
// combinations were sent if needed.
//
// Auth: CRON_SECRET Bearer.

export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCampaignGmailClient } from '@/lib/gmail/client';
import { renderTemplate } from '@/lib/email-tool/render-template';
import { log } from '@/lib/email-tool/log';
import { sanitizeCompanyForSend } from '@/lib/email-tool/company-name';

const TEST_INBOXES = [
  'videowinner14@gmail.com',
  'aditarcadedude14@gmail.com',
  'aditmittalhs@gmail.com',
];

function pickInboxForToday(): string {
  // Day-of-year mod 3. Deterministic — same inbox for any given date,
  // each gets fired every third day on rotation.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 0));
  const diffMs = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diffMs / 86_400_000);
  return TEST_INBOXES[dayOfYear % TEST_INBOXES.length];
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const toEmail = pickInboxForToday();

  // Pick a random active fresh variant — any one's fine, this is QA on
  // a rotation of subjects/body content so Adit sees every template
  // periodically.
  const { data: variantsData, error: vErr } = await supabase
    .from('email_template_variants')
    .select('id, founder_id, subject_template, body_template')
    .eq('is_active', true)
    .eq('is_followup', false);
  if (vErr) {
    return NextResponse.json({ error: 'variant_lookup_failed', detail: vErr.message }, { status: 500 });
  }
  const variants = (variantsData ?? []) as Array<{ id: string; founder_id: string; subject_template: string; body_template: string }>;
  if (variants.length === 0) {
    return NextResponse.json({ error: 'no_active_variants' }, { status: 500 });
  }
  const variant = variants[Math.floor(Math.random() * variants.length)];

  // Resolve founder for the variant — we send from this founder's
  // account so the From: header matches whoever authored the template.
  const { data: founderData } = await supabase
    .from('team_members')
    .select('id, name, email')
    .eq('id', variant.founder_id)
    .maybeSingle();
  if (!founderData) {
    return NextResponse.json({ error: 'founder_not_found' }, { status: 500 });
  }
  const founder = founderData as { id: string; name: string; email: string };

  // Render with Adit-as-test values.
  let rendered;
  try {
    rendered = renderTemplate({
      subject_template: variant.subject_template,
      body_template: variant.body_template,
      first_name: 'Adit',
      company: sanitizeCompanyForSend('Adit Testing'),
      founder_name: founder.name.split(/\s+/)[0],
    });
  } catch (err) {
    return NextResponse.json({ error: 'render_failed', detail: (err as Error).message }, { status: 500 });
  }

  // Build the email via the same RFC 2822 path the campaign uses.
  // We can't reuse sendCampaignEmail directly because it requires a
  // queueRow id (used in the tracking pixel URL). Inline a minimal
  // raw MIME here — no pixel needed since this is QA, not real
  // deliverability tracking.
  const boundary = `=pp${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const headers = [
    `From: "${founder.name}" <${founder.email}>`,
    `To: ${toEmail}`,
    `Reply-To: ${founder.email}`,
    `Subject: [QA] ${rendered.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const htmlBody = `<!doctype html><html><body><div style="white-space:pre-wrap">${rendered.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</div></body></html>`;
  const message =
    `${headers.join('\r\n')}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${rendered.body}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${htmlBody}\r\n` +
    `--${boundary}--`;
  const raw = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Send.
  try {
    const gmail = await getCampaignGmailClient(founder.id);
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    log('info', 'daily_self_test_sent', {
      to: toEmail,
      from: founder.email,
      variant_id: variant.id,
      gmail_message_id: res.data.id ?? null,
    });
    return NextResponse.json({
      ok: true,
      to: toEmail,
      from: founder.email,
      variant_id: variant.id,
      subject: `[QA] ${rendered.subject}`,
      gmail_message_id: res.data.id ?? null,
    });
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    log('error', 'daily_self_test_failed', { to: toEmail, from: founder.email, detail });
    return NextResponse.json({ error: 'send_failed', detail }, { status: 500 });
  }
}
