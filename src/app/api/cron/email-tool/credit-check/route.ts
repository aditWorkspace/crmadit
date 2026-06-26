// GET /api/cron/email-tool/credit-check — fired once each morning (vercel.json,
// 14:30 UTC ≈ 6:30/7:30 AM PT) BEFORE the day's send window (earliest 8:00 AM PT).
//
// If OpenRouter credits are empty, visual-draft image generation can't run, so
// no cold emails go out that day (this happened 2026-06-26 and we only noticed
// because the dashboard was quiet). This is the heads-up: when the balance is
// at/below the threshold, email Adit FROM Asim's connected Gmail so a founder
// can top up before the morning send.
//
// Fires once/day, so at most one nudge per day even while credits stay empty —
// no dedup bookkeeping needed.
//
// Auth: CRON_SECRET (Vercel native cron sends it automatically as a Bearer).

export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyCronAuth } from '@/lib/auth/cron';
import { getCampaignGmailClient } from '@/lib/gmail/client';
import { getOpenRouterCreditsRemaining } from '@/lib/ai/openrouter';
import { log } from '@/lib/email-tool/log';

// Credits (≈ USD) at/below which we treat OpenRouter as "empty" and alert. A
// day of image gen can burn well past this, so this is a low-water mark, not
// exact zero — raise OPENROUTER_LOW_CREDIT_USD to get an earlier warning.
const LOW_CREDIT_THRESHOLD = Number(process.env.OPENROUTER_LOW_CREDIT_USD ?? 5);

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const remaining = await getOpenRouterCreditsRemaining();
  if (remaining === null) {
    log('warn', 'credit_check_unknown'); // couldn't reach OpenRouter — don't alarm
    return NextResponse.json({ ok: true, checked: false });
  }
  if (remaining > LOW_CREDIT_THRESHOLD) {
    return NextResponse.json({ ok: true, remaining, alerted: false });
  }

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email')
    .in('name', ['Adit', 'Asim']);
  const sender = (members ?? []).find(m => (m as { name: string }).name === 'Asim') as
    | { id: string; name: string; email: string }
    | undefined;
  const recipient = (members ?? []).find(m => (m as { name: string }).name === 'Adit') as
    | { id: string; email: string }
    | undefined;
  if (!sender || !recipient) {
    log('error', 'credit_check_member_lookup_failed', { remaining });
    return NextResponse.json({ ok: false, error: 'member_lookup_failed', remaining }, { status: 500 });
  }

  const subject = '⚠️ OpenRouter credits empty — no cold emails will send today';
  const body =
    `OpenRouter credits are empty (≈ ${remaining.toFixed(2)} left).\n\n` +
    `Image generation for the visual outreach drafts can't run, so today's cold ` +
    `email batch won't go out until it's topped up.\n\n` +
    `Top up: https://openrouter.ai/settings/credits\n`;

  const headers = [
    `From: "${sender.name}" <${sender.email}>`,
    `To: ${recipient.email}`,
    `Reply-To: ${sender.email}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const gmail = await getCampaignGmailClient(sender.id);
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    log('info', 'credit_check_alert_sent', {
      remaining,
      to: recipient.email,
      from: sender.email,
      gmail_message_id: res.data.id ?? null,
    });
    return NextResponse.json({ ok: true, remaining, alerted: true, to: recipient.email });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log('error', 'credit_check_alert_failed', { remaining, detail });
    return NextResponse.json({ ok: false, error: 'send_failed', detail, remaining }, { status: 500 });
  }
}
