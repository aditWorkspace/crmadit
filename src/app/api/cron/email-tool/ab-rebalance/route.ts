// POST /api/cron/email-tool/ab-rebalance — one-day adaptive A/B test
// rebalance pass. Cron-job.org hits this hourly starting at 12 PM PT
// on the test date. The route:
//   1. Gates on today's PT date matching AB_TEST_OVERRIDE_PT_DATE
//      (which lives in start.ts). On any other date → 204 no-op.
//   2. Finds today's campaign via idempotency_key = todayPt.
//   3. If the campaign already has ab_rebalance_done_at set → 200 no-op.
//   4. Counts replies per template family for Phase A rows (send_at <
//      12:00 PM PT cutoff, status='sent'). A "family" is the unique
//      subject_template — Adit's and Asim's siblings share content so
//      we sum their counts.
//   5. Picks the top 2 families by replied count, tie-break by reply
//      rate, then subject alphabetical.
//   6. For each founder: looks up the variant IDs of the 2 winning
//      families that belong to that founder, then UPDATEs pending
//      Phase B rows (send_at >= cutoff, status='pending') alternating
//      between the two — preserving per-founder split.
//   7. Stamps email_send_campaigns.ab_rebalance_done_at so subsequent
//      hourly hits 200-no-op.
//
// Auth: CRON_SECRET Bearer (matches /api/cron/email-tool/tick).
//
// Idempotent across all error modes — repeated invocations on the same
// day after the first success are safe.

export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// MUST stay in sync with src/lib/email-tool/start.ts. If you change
// one, change the other.
const AB_TEST_OVERRIDE_PT_DATE = '2026-05-15';
const AB_TEST_PHASE_B_CUTOFF_PT_HOUR = 12.0; // 12:00 PM PT — the data cutoff

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

  if (todayPt !== AB_TEST_OVERRIDE_PT_DATE) {
    return NextResponse.json(
      { ok: true, note: 'no_op_wrong_date', today_pt: todayPt, override_pt: AB_TEST_OVERRIDE_PT_DATE },
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
  // delivery — they don't have a reply signal yet.
  const { data: phaseARows, error: aErr } = await supabase
    .from('email_send_queue')
    .select('template_variant_id, status, replied_at')
    .eq('campaign_id', campaign.id)
    .lt('send_at', cutoffIso)
    .eq('status', 'sent');
  if (aErr) {
    return NextResponse.json({ error: 'phase_a_lookup_failed', detail: aErr.message }, { status: 500 });
  }

  // Per-variant tallies.
  const sentByVariant = new Map<string, number>();
  const repliedByVariant = new Map<string, number>();
  for (const r of (phaseARows ?? []) as Array<{ template_variant_id: string; replied_at: string | null }>) {
    sentByVariant.set(r.template_variant_id, (sentByVariant.get(r.template_variant_id) ?? 0) + 1);
    if (r.replied_at) {
      repliedByVariant.set(r.template_variant_id, (repliedByVariant.get(r.template_variant_id) ?? 0) + 1);
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
  // identical subject + body). Aggregate sent + replied per family.
  type FamilyAgg = { subject: string; variantIds: string[]; sent: number; replied: number };
  const familiesBySubject = new Map<string, FamilyAgg>();
  for (const v of variants) {
    const key = v.subject_template;
    let agg = familiesBySubject.get(key);
    if (!agg) {
      agg = { subject: key, variantIds: [], sent: 0, replied: 0 };
      familiesBySubject.set(key, agg);
    }
    agg.variantIds.push(v.id);
    agg.sent += sentByVariant.get(v.id) ?? 0;
    agg.replied += repliedByVariant.get(v.id) ?? 0;
  }
  const families = Array.from(familiesBySubject.values());

  if (families.length < 2) {
    return NextResponse.json(
      { error: 'not_enough_families', detail: `expected ≥2 active fresh families, got ${families.length}` },
      { status: 500 }
    );
  }

  // Rank: replied DESC, then reply-rate DESC, then subject ASC (stable
  // alphabetic tie-break).
  families.sort((a, b) => {
    if (b.replied !== a.replied) return b.replied - a.replied;
    const rateA = a.sent > 0 ? a.replied / a.sent : 0;
    const rateB = b.sent > 0 ? b.replied / b.sent : 0;
    if (rateB !== rateA) return rateB - rateA;
    return a.subject.localeCompare(b.subject);
  });
  const winners = families.slice(0, 2);

  // Find pending Phase B rows per founder. Round-robin alternate
  // between the 2 winning variants belonging to THAT founder.
  const updated: Record<string, number> = {};
  const { data: founderRows } = await supabase
    .from('team_members')
    .select('id, name')
    .is('departed_at', null);
  const activeFounders = (founderRows ?? []) as Array<{ id: string; name: string }>;

  for (const founder of activeFounders) {
    // The two winning variants for THIS founder. Each family has one
    // variant per founder (siblings). Find them by intersecting
    // family.variantIds with variants whose founder_id matches.
    const winnerVariantIds = winners.map(w =>
      variants.find(v => v.founder_id === founder.id && w.variantIds.includes(v.id))?.id
    ).filter((id): id is string => !!id);
    if (winnerVariantIds.length < 2) {
      // Missing one of the founder's winning variants (unexpected,
      // would imply schema mismatch). Skip this founder's rebalance.
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
      replied: f.replied,
      reply_rate_pct: f.sent > 0 ? Math.round((f.replied / f.sent) * 1000) / 10 : 0,
    })),
    winners: winners.map(w => w.subject),
    rows_updated: updated,
  });
}
