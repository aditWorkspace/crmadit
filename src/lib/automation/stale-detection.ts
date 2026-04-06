import { createAdminClient } from '@/lib/supabase/admin';
import { STALE_THRESHOLDS, ACTIVE_STAGES } from '@/lib/constants';
import { LeadStage } from '@/types';
import { differenceInHours } from 'date-fns';

export interface StaleAlertResult {
  lead_id: string;
  contact_name: string;
  company_name: string;
  stage: LeadStage;
  hours_stale: number;
  threshold_hrs: number;
  owned_by: string;
  severity: 'critical' | 'warning';
}

export async function detectStaleLeads(): Promise<StaleAlertResult[]> {
  const supabase = createAdminClient();

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, last_contact_at, owned_by, call_completed_at, created_at')
    .in('stage', ACTIVE_STAGES.filter(s => s !== 'paused'))
    .eq('is_archived', false);

  if (error || !leads) return [];

  const stale: StaleAlertResult[] = [];
  const now = new Date();

  for (const lead of leads) {
    const threshold = STALE_THRESHOLDS[lead.stage as LeadStage];
    if (!threshold) continue;

    const referenceDate = lead.last_contact_at || lead.call_completed_at || lead.created_at;
    if (!referenceDate) continue;

    const hoursElapsed = differenceInHours(now, new Date(referenceDate));
    if (hoursElapsed > threshold) {
      stale.push({
        lead_id: lead.id,
        contact_name: lead.contact_name,
        company_name: lead.company_name,
        stage: lead.stage as LeadStage,
        hours_stale: Math.round(hoursElapsed),
        threshold_hrs: threshold,
        owned_by: lead.owned_by,
        severity: hoursElapsed > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }

  return stale.sort((a, b) => b.hours_stale - a.hours_stale);
}

export async function createStaleFollowUps(staleAlerts: StaleAlertResult[]): Promise<void> {
  const supabase = createAdminClient();

  for (const alert of staleAlerts) {
    // Check if there's already a pending stale alert for this lead
    const { data: existing } = await supabase
      .from('follow_up_queue')
      .select('id')
      .eq('lead_id', alert.lead_id)
      .eq('type', 'stale_alert')
      .eq('status', 'pending')
      .limit(1);

    if (existing && existing.length > 0) continue;

    await supabase.from('follow_up_queue').insert({
      lead_id: alert.lead_id,
      assigned_to: alert.owned_by,
      type: 'stale_alert',
      reason: `Lead has been stale for ${alert.hours_stale} hours (threshold: ${alert.threshold_hrs}h)`,
      due_at: new Date().toISOString(),
      auto_send: false,
      status: 'pending',
    });
  }
}
