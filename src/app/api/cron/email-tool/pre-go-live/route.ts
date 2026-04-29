// Admin endpoint: runs all queryable pre-go-live checks and returns a
// status report for the Schedule tab UI. Manual self-attest items
// (Vercel Pro, plus-aliasing, Sentry) aren't queried here — those have
// their own checkboxes that the admin toggles in the UI.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

interface CheckResult {
  id: string;
  label: string;
  required: boolean;
  status: 'ok' | 'fail';
  detail?: string;
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  const checks: CheckResult[] = [];

  // 1) Each founder has ≥2 active variants
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name, gmail_connected');
  const founders = (foundersData ?? []) as Array<{ id: string; name: string; gmail_connected: boolean }>;
  const { data: variantsData } = await supabase
    .from('email_template_variants')
    .select('founder_id, is_active')
    .eq('is_active', true);
  const activeByFounder = new Map<string, number>();
  for (const v of (variantsData ?? []) as Array<{ founder_id: string }>) {
    activeByFounder.set(v.founder_id, (activeByFounder.get(v.founder_id) ?? 0) + 1);
  }
  const insufficientVariants = founders.filter(f => (activeByFounder.get(f.id) ?? 0) < 2);
  checks.push({
    id: 'min_active_variants',
    label: 'Each founder has ≥2 active templates',
    required: true,
    status: insufficientVariants.length === 0 ? 'ok' : 'fail',
    detail: insufficientVariants.length === 0
      ? `${founders.length} founders, all with ≥2 active variants`
      : `${insufficientVariants.length} founder(s) below minimum: ${insufficientVariants.map(f => f.name).join(', ')}`,
  });

  // 2) Gmail OAuth tokens valid
  const disconnected = founders.filter(f => !f.gmail_connected);
  checks.push({
    id: 'gmail_connected',
    label: 'All founders have Gmail OAuth connected',
    required: true,
    status: disconnected.length === 0 ? 'ok' : 'fail',
    detail: disconnected.length === 0
      ? `${founders.length}/${founders.length} connected`
      : `Disconnected: ${disconnected.map(f => f.name).join(', ')}`,
  });

  // 3) At least one dry_run campaign in last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: dryRunCount } = await supabase
    .from('email_send_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('send_mode', 'dry_run')
    .eq('status', 'done')
    .gte('completed_at', sevenDaysAgo);
  checks.push({
    id: 'dry_run_recent',
    label: 'At least one successful dry_run campaign in last 7 days',
    required: true,
    status: (dryRunCount ?? 0) > 0 ? 'ok' : 'fail',
    detail: `${dryRunCount ?? 0} done dry-run campaigns in last 7 days`,
  });

  // 4) At least one allowlist campaign in last 7 days
  const { count: allowlistCount } = await supabase
    .from('email_send_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('send_mode', 'allowlist')
    .eq('status', 'done')
    .gte('completed_at', sevenDaysAgo);
  checks.push({
    id: 'allowlist_recent',
    label: 'At least one successful allowlist campaign in last 7 days',
    required: true,
    status: (allowlistCount ?? 0) > 0 ? 'ok' : 'fail',
    detail: `${allowlistCount ?? 0} done allowlist campaigns in last 7 days`,
  });

  // 5) Schedule disabled by default — informational, not a blocker
  const { data: schedRow } = await supabase
    .from('email_send_schedule')
    .select('enabled')
    .eq('id', 1)
    .single();
  const enabled = (schedRow as { enabled: boolean } | null)?.enabled ?? false;
  checks.push({
    id: 'schedule_state',
    label: 'Schedule state',
    required: false,
    status: 'ok', // informational — both states are fine
    detail: enabled ? '⚠ Currently ENABLED — automated runs will fire.' : 'Currently DISABLED — flip on in Master Controls when ready.',
  });

  return NextResponse.json({ checks });
}
