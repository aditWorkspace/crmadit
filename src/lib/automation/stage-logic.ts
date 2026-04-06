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

type StageTrigger = {
  validate?: (lead: Lead) => { valid: boolean; error?: string };
  onEnter: (lead: Lead, teamMemberId: string) => Promise<void>;
};

const stageRegistry: Record<string, StageTrigger> = {
  replied: {
    onEnter: async (lead, memberId) => {
      if (!lead.first_reply_at) {
        await updateLead(lead.id, { first_reply_at: new Date().toISOString() });
      }
      await createActionItem({
        lead_id: lead.id,
        text: `Respond to ${lead.contact_name}'s reply`,
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
        reason: 'No scheduling confirmation after 48 hours',
        due_at: addHours(new Date(), 48).toISOString(),
        auto_send: true,
        suggested_message: `Hi ${lead.contact_name.split(' ')[0]}, just wanted to follow up on this — would love to find a time that works if you're still open to it!`,
      });
    },
  },

  scheduled: {
    validate: (lead) => {
      if (!lead.call_scheduled_for) {
        return { valid: false, error: 'Must set a call date/time before marking as scheduled' };
      }
      return { valid: true };
    },
    onEnter: async (lead) => {
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'custom',
        reason: `Call with ${lead.contact_name} at ${lead.company_name}`,
        due_at: addHours(new Date(lead.call_scheduled_for!), -1).toISOString(),
      });
    },
  },

  call_completed: {
    onEnter: async (lead, memberId) => {
      const now = new Date().toISOString();
      if (!lead.call_completed_at) {
        await updateLead(lead.id, { call_completed_at: now });
      }
      await createActionItem({
        lead_id: lead.id,
        text: 'Upload call transcript',
        assigned_to: memberId,
        due_date: addHours(new Date(), 2).toISOString().split('T')[0],
        source: 'auto_generated',
      });
      await createActionItem({
        lead_id: lead.id,
        text: `Send product demo/access to ${lead.contact_name}`,
        assigned_to: lead.owned_by,
        due_date: addHours(new Date(), 4).toISOString().split('T')[0],
        source: 'auto_generated',
      });
    },
  },

  demo_sent: {
    onEnter: async (lead) => {
      const now = new Date().toISOString();
      if (!lead.demo_sent_at) {
        await updateLead(lead.id, { demo_sent_at: now });
      }
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: `Check if ${lead.contact_name} has tried the product`,
        due_at: addDays(new Date(), 3).toISOString(),
      });
    },
  },

  active_user: {
    onEnter: async (lead) => {
      await updateLead(lead.id, { product_access_granted_at: new Date().toISOString() });
      await createFollowUp({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'check_in',
        reason: 'Weekly check-in with active user',
        due_at: addDays(new Date(), 7).toISOString(),
      });
    },
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
  });

  if (trigger?.onEnter) {
    await trigger.onEnter({ ...lead, stage: newStage } as Lead, teamMemberId);
  }

  return { success: true };
}
