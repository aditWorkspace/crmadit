import { createAdminClient } from '@/lib/supabase/admin';

const CALL_GRACE_PERIOD_MINUTES = 30;

export interface AutoStageResult {
  confirmations_created: number;
  errors: string[];
}

/**
 * Find leads in 'scheduled' where the call time has passed by more than
 * the grace period and surface a call_confirmation follow-up on the dashboard.
 * The founder confirms "did the call happen?" — we never auto-advance to
 * call_completed without human confirmation.
 */
export async function runAutoStageAdvance(): Promise<AutoStageResult> {
  const result: AutoStageResult = { confirmations_created: 0, errors: [] };
  const supabase = createAdminClient();

  const cutoff = new Date(Date.now() - CALL_GRACE_PERIOD_MINUTES * 60 * 1000).toISOString();

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, owned_by, call_scheduled_for')
    .eq('stage', 'scheduled')
    .eq('is_archived', false)
    .not('call_scheduled_for', 'is', null)
    .lt('call_scheduled_for', cutoff);

  if (error) {
    result.errors.push(`Query error: ${error.message}`);
    return result;
  }

  if (!leads || leads.length === 0) return result;

  for (const lead of leads) {
    try {
      // Skip if there's already a pending call_confirmation for this lead
      const { data: existing } = await supabase
        .from('follow_up_queue')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'call_confirmation')
        .eq('status', 'pending')
        .maybeSingle();

      if (existing) continue;

      await supabase.from('follow_up_queue').insert({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'call_confirmation',
        reason: `Did your call with ${lead.contact_name} (${lead.company_name}) happen?`,
        due_at: new Date().toISOString(),
        auto_send: false,
        status: 'pending',
      });

      result.confirmations_created++;
    } catch (err) {
      result.errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
