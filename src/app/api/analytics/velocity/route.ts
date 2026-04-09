import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

/**
 * Pipeline velocity: average days spent in each stage.
 * Computed from activity_log stage_changed events.
 */

const STAGE_ORDER = [
  'replied', 'scheduling', 'scheduled', 'call_completed',
  'post_call', 'demo_sent', 'feedback_call', 'active_user',
];

const STAGE_LABELS: Record<string, string> = {
  replied: 'Awaiting Reply',
  scheduling: 'Scheduling',
  scheduled: 'Scheduled',
  call_completed: 'Call Completed',
  post_call: 'Post-Call',
  demo_sent: 'Demo Sent',
  feedback_call: 'Feedback Call',
  active_user: 'Active User',
};

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Get all stage_changed events, ordered by lead + time
  const { data: events, error } = await supabase
    .from('activity_log')
    .select('lead_id, details, created_at')
    .eq('action', 'stage_changed')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group events by lead
  const byLead: Record<string, { from: string; to: string; at: string }[]> = {};
  for (const ev of events ?? []) {
    if (!ev.lead_id || !ev.details) continue;
    const d = ev.details as { from_stage?: string; to_stage?: string };
    if (!d.from_stage || !d.to_stage) continue;
    if (!byLead[ev.lead_id]) byLead[ev.lead_id] = [];
    byLead[ev.lead_id].push({ from: d.from_stage, to: d.to_stage, at: ev.created_at });
  }

  // For each stage, collect durations (time spent before leaving)
  const stageDurations: Record<string, number[]> = {};
  for (const stage of STAGE_ORDER) stageDurations[stage] = [];

  for (const transitions of Object.values(byLead)) {
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      // Duration in stage = time from entering to leaving
      // The "from" stage is the one we're measuring
      if (i === 0) {
        // First transition: we don't know when they entered from_stage
        // Use lead created_at as approximation — skip for accuracy
        continue;
      }
      const prevTransitionTime = new Date(transitions[i - 1].at).getTime();
      const thisTransitionTime = new Date(t.at).getTime();
      const daysInStage = (thisTransitionTime - prevTransitionTime) / (1000 * 60 * 60 * 24);
      if (daysInStage >= 0 && daysInStage < 365 && stageDurations[t.from]) {
        stageDurations[t.from].push(daysInStage);
      }
    }
  }

  // Compute averages
  const velocity = STAGE_ORDER.map(stage => {
    const durations = stageDurations[stage];
    const avg = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;
    return {
      stage,
      label: STAGE_LABELS[stage] ?? stage,
      avg_days: avg !== null ? Math.round(avg * 10) / 10 : null,
      sample_count: durations.length,
    };
  });

  // Conversion funnel drop-offs
  const { data: leads } = await supabase
    .from('leads')
    .select('stage')
    .eq('is_archived', false);

  const stageCounts: Record<string, number> = {};
  for (const lead of leads ?? []) {
    stageCounts[lead.stage] = (stageCounts[lead.stage] || 0) + 1;
  }

  // Count leads that reached each stage (cumulative — anyone currently at or past this stage)
  const reachedStage: Record<string, number> = {};
  for (const stage of STAGE_ORDER) {
    const idx = STAGE_ORDER.indexOf(stage);
    reachedStage[stage] = STAGE_ORDER
      .filter((_, i) => i >= idx)
      .reduce((sum, s) => sum + (stageCounts[s] || 0), 0);
  }

  const dropoffs = STAGE_ORDER.slice(0, -1).map((stage, i) => {
    const current = reachedStage[stage] || 0;
    const next = reachedStage[STAGE_ORDER[i + 1]] || 0;
    const dropRate = current > 0 ? Math.round(((current - next) / current) * 100) : 0;
    return {
      from_stage: stage,
      from_label: STAGE_LABELS[stage] ?? stage,
      to_stage: STAGE_ORDER[i + 1],
      to_label: STAGE_LABELS[STAGE_ORDER[i + 1]] ?? STAGE_ORDER[i + 1],
      from_count: current,
      to_count: next,
      drop_rate: dropRate,
    };
  });

  return NextResponse.json({ velocity, dropoffs });
}
