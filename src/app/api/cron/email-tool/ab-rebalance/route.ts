// POST /api/cron/email-tool/ab-rebalance — one-day adaptive A/B test
// rebalance pass. Cron-job.org hits this at 8:30/8:45/8:55am PT on each
// test date (three attempts before Phase B starts at 9:00am PT). The
// route:
//   1. Gates on today's PT date being in AB_TEST_OVERRIDE_PT_DATES
//      (mirrored from start.ts). On any other date → 200 no-op.
//   2. Finds today's campaign via idempotency_key = todayPt.
//   3. If the campaign already has ab_rebalance_done_at set → 200 no-op.
//   4. Counts opens per template family for Phase A rows (send_at <
//      8:30 AM PT cutoff, status='sent'). A "family" is the unique
//      subject_template — Adit's and Asim's siblings share content so
//      we sum their counts.
//   5. Picks the SINGLE top family by open rate, tie-break by reply
//      rate, then subject alphabetical. (Previously top-2 with round-
//      robin — user switched to top-1 on 2026-05-16 for higher signal
//      with the 1-hour open window.)
//   6. For each founder: looks up the variant ID of the winning family
//      that belongs to that founder, then UPDATEs all pending Phase B
//      rows (send_at >= cutoff, status='pending') to use that variant.
//   7. Stamps email_send_campaigns.ab_rebalance_done_at so subsequent
//      retries (8:45, 8:55) 200-no-op.
//
// Auth: CRON_SECRET Bearer (matches /api/cron/email-tool/tick).
//
// Idempotent across all error modes — repeated invocations on the same
// day after the first success are safe.

export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { log } from '@/lib/email-tool/log';

// MUST stay in sync with src/lib/email-tool/start.ts. If you change
// one, change the other.
const AB_TEST_OVERRIDE_PT_DATES = new Set<string>([
  '2026-05-17', // Sun
  '2026-05-18', // Mon
  '2026-05-19', // Tue
  '2026-05-20', // Wed
  '2026-05-21', // Thu
  '2026-05-22', // Fri
]);
// Data cutoff for Phase A signals (8:30 AM PT). Phase B in start.ts
// starts at 9:00 AM PT — the 30-min gap gives this route time to
// rebalance pending Phase B rows before they fire.
const AB_TEST_PHASE_B_CUTOFF_PT_HOUR = 8.5; // 8:30 AM PT — the data cutoff

function formatPtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function ptCutoffMs(now: Date, hour: number): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = fmt.format(now).split('-').map(Number);
  const h = Math.floor(hour);
  const mi = Math.round((hour - h) * 60);
  const tentative = new Date(Date.UTC(y, m - 1, d, h + 8, mi));
  const tzAbbrev = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  }).formatToParts(tentative).find(p => p.type === 'timeZoneName')?.value;
  const offsetCorrectionMs = tzAbbrev === 'PDT' ? -60 * 60_000 : 0;
  return tentative.getTime() + offsetCorrectionMs;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const todayPt = formatPtDate(now);

  if (!AB_TEST_OVERRIDE_PT_DATES.has(todayPt)) {
    return NextResponse.json(
      {
        ok: true,
        note: 'no_op_wrong_date',
        today_pt: todayPt,
        override_pt: Array.from(AB_TEST_OVERRIDE_PT_DATES),
      },
      { status: 200 }
    );
  }

  // Find today's campaign. Use idempotency_key = today's PT date
  // (matches the default in start.ts when no manual override is passed).
  const { data: campaign, error: campaignErr } = await supabase
    .from('email_send_campaigns')
    .select('id, ab_rebalance_done_at')
    .eq('idempotency_key', todayPt)
    .maybeSingle();
  if (campaignErr) {
    return NextResponse.json({ error: 'campaign_lookup_failed', detail: campaignErr.message }, { status: 500 });
  }
  if (!campaign) {
    return NextResponse.json({ ok: true, note: 'no_campaign_for_today' }, { status: 200 });
  }
  if (campaign.ab_rebalance_done_at) {
    return NextResponse.json(
      { ok: true, note: 'already_rebalanced', at: campaign.ab_rebalance_done_at },
      { status: 200 }
    );
  }

  const cutoffIso = new Date(ptCutoffMs(now, AB_TEST_PHASE_B_CUTOFF_PT_HOUR)).toISOString();

  // Phase A rows: send_at < 12 PM PT, status='sent'. We only count
  // *sent* rows because rows still in 'pending' haven't even attempted
  // delivery — they don't have an open or reply signal yet.
  const { data: phaseARows, error: aErr } = await supabase
    .from('email_send_queue')
    .select('template_variant_id, status, replied_at, opened_at')
    .eq('campaign_id', campaign.id)
    .lt('send_at', cutoffIso)
    .eq('status', 'sent');
  if (aErr) {
    return NextResponse.json({ error: 'phase_a_lookup_failed', detail: aErr.message }, { status: 500 });
  }

  // Per-variant tallies: sent / replied / opened.
  const sentByVariant = new Map<string, number>();
  const repliedByVariant = new Map<string, number>();
  const openedByVariant = new Map<string, number>();
  for (const r of (phaseARows ?? []) as Array<{ template_variant_id: string; replied_at: string | null; opened_at: string | null }>) {
    sentByVariant.set(r.template_variant_id, (sentByVariant.get(r.template_variant_id) ?? 0) + 1);
    if (r.replied_at) {
      repliedByVariant.set(r.template_variant_id, (repliedByVariant.get(r.template_variant_id) ?? 0) + 1);
    }
    if (r.opened_at) {
      openedByVariant.set(r.template_variant_id, (openedByVariant.get(r.template_variant_id) ?? 0) + 1);
    }
  }

  // Variant metadata for family grouping. Only consider active fresh
  // variants — followups (is_followup=true) are excluded from the
  // test rotation anyway and won't appear in Phase A rows.
  const { data: variantRows, error: vErr } = await supabase
    .from('email_template_variants')
    .select('id, founder_id, subject_template, label, is_active, is_followup');
  if (vErr) {
    return NextResponse.json({ error: 'variant_lookup_failed', detail: vErr.message }, { status: 500 });
  }
  interface VRow {
    id: string; founder_id: string;
    subject_template: string; label: string;
    is_active: boolean; is_followup: boolean;
  }
  const variants = ((variantRows ?? []) as VRow[]).filter(v => v.is_active && !v.is_followup);

  // Family key = subject_template (siblings across founders share
  // identical subject + body). Aggregate sent + replied + opened per family.
  type FamilyAgg = { subject: string; variantIds: string[]; sent: number; replied: number; opened: number };
  const familiesBySubject = new Map<string, FamilyAgg>();
  for (const v of variants) {
    const key = v.subject_template;
    let agg = familiesBySubject.get(key);
    if (!agg) {
      agg = { subject: key, variantIds: [], sent: 0, replied: 0, opened: 0 };
      familiesBySubject.set(key, agg);
    }
    agg.variantIds.push(v.id);
    agg.sent += sentByVariant.get(v.id) ?? 0;
    agg.replied += repliedByVariant.get(v.id) ?? 0;
    agg.opened += openedByVariant.get(v.id) ?? 0;
  }
  const families = Array.from(familiesBySubject.values());

  if (families.length < 2) {
    return NextResponse.json(
      { error: 'not_enough_families', detail: `expected ≥2 active fresh families, got ${families.length}` },
      { status: 500 }
    );
  }

  // Insufficient-data fallback: if Phase A hasn't drained enough yet
  // (e.g., the cron fired too early or sends are slow), the open
  // metric is noisy. Refuse to rebalance and let Phase B drain with
  // all 4 variants. Threshold: 80 sent per family (80% of the
  // expected 100/family Phase A volume). The cron retries at 8:45 and
  // 8:55 AM PT, so a slow drain still gets two more chances before
  // Phase B starts at 9:00 AM PT.
  const minSentPerFamily = Math.min(...families.map(f => f.sent));
  const INSUFFICIENT_DATA_THRESHOLD = 80;
  if (minSentPerFamily < INSUFFICIENT_DATA_THRESHOLD) {
    log('warn', 'ab_rebalance_insufficient_data', {
      campaign_id: campaign.id,
      min_sent_per_family: minSentPerFamily,
      threshold: INSUFFICIENT_DATA_THRESHOLD,
      per_family: families.map(f => ({ subject: f.subject, sent: f.sent })),
    });
    return NextResponse.json({
      ok: true,
      note: 'insufficient_data',
      detail: `at least one family has only ${minSentPerFamily} sent (< ${INSUFFICIENT_DATA_THRESHOLD}); not rebalancing — will retry next hour`,
      families_evaluated: families.map(f => ({
        subject: f.subject,
        sent: f.sent,
        opened: f.opened,
        replied: f.replied,
      })),
    });
  }

  // Rank by OPEN RATE (opens/sent) — the user explicitly switched the
  // metric after Friday's run, where 0 replies at noon caused the old
  // "replied DESC" ranking to fall through to alphabetical. Opens
  // accumulate within minutes of send; replies take hours. Tertiary
  // tie-break is reply-rate so opens-tied families fall back to the
  // stronger signal, then subject ASC for determinism.
  families.sort((a, b) => {
    const openRateA = a.sent > 0 ? a.opened / a.sent : 0;
    const openRateB = b.sent > 0 ? b.opened / b.sent : 0;
    if (openRateB !== openRateA) return openRateB - openRateA;
    const replyRateA = a.sent > 0 ? a.replied / a.sent : 0;
    const replyRateB = b.sent > 0 ? b.replied / b.sent : 0;
    if (replyRateB !== replyRateA) return replyRateB - replyRateA;
    return a.subject.localeCompare(b.subject);
  });
  const winners = families.slice(0, 1);
  log('info', 'ab_rebalance_picked', {
    campaign_id: campaign.id,
    winners: winners.map(w => ({
      subject: w.subject,
      sent: w.sent,
      opened: w.opened,
      replied: w.replied,
      open_rate_pct: w.sent > 0 ? Math.round((w.opened / w.sent) * 1000) / 10 : 0,
    })),
  });

  // Find pending Phase B rows per founder. Rewrite each row's
  // template_variant_id to the single winning variant for THAT founder.
  const updated: Record<string, number> = {};
  const { data: founderRows } = await supabase
    .from('team_members')
    .select('id, name')
    .is('departed_at', null);
  const activeFounders = (founderRows ?? []) as Array<{ id: string; name: string }>;

  for (const founder of activeFounders) {
    // The winning variant for THIS founder. Each family has one
    // variant per founder (siblings). Find it by intersecting
    // family.variantIds with variants whose founder_id matches.
    const winnerVariantIds = winners.map(w =>
      variants.find(v => v.founder_id === founder.id && w.variantIds.includes(v.id))?.id
    ).filter((id): id is string => !!id);
    if (winnerVariantIds.length < 1) {
      // Missing the founder's winning variant (unexpected, would imply
      // schema mismatch). Skip this founder's rebalance.
      updated[founder.name] = 0;
      continue;
    }

    // Pull pending Phase B rows in send_at order. We rewrite their
    // template_variant_id to the two winners alternating.
    const { data: pendingRows, error: pErr } = await supabase
      .from('email_send_queue')
      .select('id, send_at')
      .eq('campaign_id', campaign.id)
      .eq('account_id', founder.id)
      .eq('status', 'pending')
      .gte('send_at', cutoffIso)
      .order('send_at', { ascending: true });
    if (pErr) {
      return NextResponse.json(
        { error: 'pending_lookup_failed', founder: founder.name, detail: pErr.message },
        { status: 500 }
      );
    }
    let nUpdated = 0;
    for (let i = 0; i < (pendingRows ?? []).length; i++) {
      const targetVariant = winnerVariantIds[i % winnerVariantIds.length];
      const { error: upErr } = await supabase
        .from('email_send_queue')
        .update({ template_variant_id: targetVariant })
        .eq('id', pendingRows![i].id)
        .eq('status', 'pending'); // CAS guard against rows that started sending mid-update
      if (!upErr) nUpdated++;
    }
    updated[founder.name] = nUpdated;
  }

  // Idempotency stamp.
  await supabase
    .from('email_send_campaigns')
    .update({ ab_rebalance_done_at: now.toISOString() })
    .eq('id', campaign.id);

  return NextResponse.json({
    ok: true,
    cutoff_iso: cutoffIso,
    families_evaluated: families.map(f => ({
      subject: f.subject,
      sent: f.sent,
      opened: f.opened,
      replied: f.replied,
      open_rate_pct: f.sent > 0 ? Math.round((f.opened / f.sent) * 1000) / 10 : 0,
      reply_rate_pct: f.sent > 0 ? Math.round((f.replied / f.sent) * 1000) / 10 : 0,
    })),
    winners: winners.map(w => w.subject),
    rows_updated: updated,
  });
}
