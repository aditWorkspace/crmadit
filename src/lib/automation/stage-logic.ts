import { createAdminClient } from '@/lib/supabase/admin';
import { Lead, LeadStage } from '@/types';
import { addHours, addDays } from '@/lib/utils';

async function updateLead(leadId: string, updates: Partial<Lead>) {
  const supabase = createAdminClient();
  await supabase.from('leads').update(updates).eq('id', leadId);
}

async function createActionItem(item: {
  lead_id: string;
  text: string;
  assigned_to?: string;
  due_date?: string;
  source: 'manual' | 'ai_extracted' | 'auto_generated';
  metadata?: Record<string, unknown>;
}) {
  const supabase = createAdminClient();
  await supabase.from('action_items').insert(item);
}

async function createFollowUp(followUp: {
  lead_id: string;
  assigned_to?: string;
  type: string;
  reason?: string;
  due_at: string;
  auto_send?: boolean;
  suggested_message?: string;
}) {
  const supabase = createAdminClient();
  await supabase.from('follow_up_queue').insert(followUp);
}

async function dismissAllPendingFollowUps(leadId: string) {
  const supabase = createAdminClient();
  await supabase
    .from('follow_up_queue')
    .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('status', 'pending');
}

/**
 * Compute hours from call_completed_at to the first outbound email after that.
 * Returns null if not enough data.
 */
export async function computePostCallFollowupHrs(leadId: string, callCompletedAt: string): Promise<number | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('interactions')
    .select('occurred_at')
    .eq('lead_id', leadId)
    .eq('type', 'email_outbound')
    .gt('occurred_at', callCompletedAt)
    .order('occurred_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const hrs = (new Date(data.occurred_at).getTime() - new Date(callCompletedAt).getTime()) / (1000 * 60 * 60);
  return Math.round(hrs * 10) / 10;
}

type StageTrigger = {
  validate?: (lead: Lead) => { valid: boolean; error?: string };
  onEnter: (lead: Lead, teamMemberId: string) => Promise<void>;
};

const stageRegistry: Record<string, StageTrigger> = {
  replied: {
    onEnter: async (lead) => {
      await createActionItem({
        lead_id: lead.id,
        text: `Reply to ${lead.contact_name} — they're in dialogue`,
        assigned_to: lead.owned_by,
        due_date: addHours(new Date(), 4).toISOString().split('T')[0],
        source: 'auto_generated',
      });
    },
  },

  scheduling: {
    onEnter: async (lead) => {
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'auto_email_followup',
        reason: 'No call booked after 48 hours — follow up to schedule',
        due_at: addHours(new Date(), 48).toISOString(),
        auto_send: true,
        suggested_message: `Hi ${lead.contact_name.split(' ')[0]}, just circling back — still happy to jump on a quick call if it works for you!`,
      });
    },
  },

  scheduled: {
    validate: (lead) => {
      if (!lead.call_scheduled_for) {
        return { valid: false, error: 'Set a call date/time before marking as scheduled' };
      }
      return { valid: true };
    },
    onEnter: async (lead) => {
      // Auto-elevate priority when a discovery call is booked
      const priorityUpgrade = lead.priority === 'low' || lead.priority === 'medium' ? 'high' : lead.priority;
      if (priorityUpgrade !== lead.priority) {
        await updateLead(lead.id, { priority: priorityUpgrade });
      }
      // Pre-call reminder
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'custom',
        reason: `Discovery call with ${lead.contact_name} at ${lead.company_name}`,
        due_at: addHours(new Date(lead.call_scheduled_for!), -1).toISOString(),
      });
    },
  },

  call_completed: {
    onEnter: async (lead, memberId) => {
      await createActionItem({
        lead_id: lead.id,
        text: 'Upload discovery call transcript',
        assigned_to: memberId,
        due_date: addHours(new Date(), 2).toISOString().split('T')[0],
        source: 'auto_generated',
        metadata: { urgency: 'immediate', action_type: 'upload_transcript' },
      });
      await createActionItem({
        lead_id: lead.id,
        text: `Send product demo/access to ${lead.contact_name}`,
        assigned_to: lead.owned_by,
        due_date: addHours(new Date(), 6).toISOString().split('T')[0],
        source: 'auto_generated',
      });
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'post_call_followup',
        reason: `Send demo + follow-up email to ${lead.contact_name} after discovery call`,
        due_at: addHours(new Date(), 6).toISOString(),
      });
    },
  },

  demo_sent: {
    onEnter: async (lead) => {
      await createActionItem({
        lead_id: lead.id,
        text: `Schedule feedback call with ${lead.contact_name}`,
        assigned_to: lead.owned_by,
        due_date: addDays(new Date(), 3).toISOString().split('T')[0],
        source: 'auto_generated',
      });
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: `Check if ${lead.contact_name} has tried the demo — push to book feedback call`,
        due_at: addDays(new Date(), 3).toISOString(),
      });
    },
  },

  feedback_call: {
    onEnter: async (lead) => {
      await createActionItem({
        lead_id: lead.id,
        text: `Run feedback call with ${lead.contact_name} — get product feedback`,
        assigned_to: lead.owned_by,
        due_date: addDays(new Date(), 7).toISOString().split('T')[0],
        source: 'auto_generated',
      });
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: `Book or confirm feedback call with ${lead.contact_name}`,
        due_at: addDays(new Date(), 7).toISOString(),
      });
    },
  },

  active_user: {
    onEnter: async (lead) => {
      await createActionItem({
        lead_id: lead.id,
        text: `Set up recurring weekly call cadence with ${lead.contact_name}`,
        assigned_to: lead.owned_by,
        due_date: addDays(new Date(), 3).toISOString().split('T')[0],
        source: 'auto_generated',
      });
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: `Weekly call with ${lead.contact_name}`,
        due_at: addDays(new Date(), 7).toISOString(),
      });
    },
  },

  // Legacy stage — kept for DB compat, no automation
  post_call: {
    onEnter: async (_lead, _memberId) => {},
  },

  paused: {
    onEnter: async (lead) => {
      await dismissAllPendingFollowUps(lead.id);
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: `Circle back with ${lead.contact_name} — they asked to reconnect later`,
        due_at: addDays(new Date(), 14).toISOString(),
      });
    },
  },

  dead: {
    onEnter: async (lead) => {
      await dismissAllPendingFollowUps(lead.id);
    },
  },
};

export async function changeStage(
  leadId: string,
  newStage: LeadStage,
  teamMemberId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (fetchError || !lead) return { success: false, error: 'Lead not found' };

  const trigger = stageRegistry[newStage];

  if (trigger?.validate) {
    const result = trigger.validate(lead as Lead);
    if (!result.valid) return { success: false, error: result.error };
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { stage: newStage, updated_at: now };

  if (newStage === 'replied' && !lead.first_reply_at) updates.first_reply_at = now;
  if (newStage === 'call_completed' && !lead.call_completed_at) updates.call_completed_at = now;
  if (newStage === 'demo_sent' && !lead.demo_sent_at) updates.demo_sent_at = now;
  if (newStage === 'active_user' && !lead.product_access_granted_at) updates.product_access_granted_at = now;
  // feedback_call: reuse call_scheduled_for for the feedback call date (set manually by founder)
  if (newStage === 'feedback_call') updates.priority = lead.priority === 'low' ? 'medium' : lead.priority;

  const { error: updateError } = await supabase.from('leads').update(updates).eq('id', leadId);
  if (updateError) return { success: false, error: updateError.message };

  await supabase.from('activity_log').insert({
    lead_id: leadId,
    team_member_id: teamMemberId,
    action: 'stage_changed',
    details: { from: lead.stage, to: newStage },
  });

  await supabase.from('interactions').insert({
    lead_id: leadId,
    team_member_id: teamMemberId,
    type: 'stage_change',
    body: `Stage changed from ${lead.stage} to ${newStage}`,
    occurred_at: now,
    metadata: {},
  });

  if (trigger?.onEnter) {
    await trigger.onEnter({ ...lead, stage: newStage } as Lead, teamMemberId);
  }

  return { success: true };
}
