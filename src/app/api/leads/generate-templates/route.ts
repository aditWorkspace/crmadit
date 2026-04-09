export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { callAI } from '@/lib/ai/openrouter';
import { QWEN_FREE_MODEL, STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';

interface TemplateResult {
  lead_id: string;
  contact_name: string;
  company_name: string;
  owner: string;
  trigger: string;
  subject: string;
  body: string;
}

const TEMPLATE_TYPES: Record<string, string> = {
  stale_followup: 'Follow up — no response in a while',
  post_call: 'Post-call follow-up with next steps',
  check_in: 'Friendly check-in on product usage',
  re_engagement: 'Re-engage a cold lead',
  schedule_nudge: 'Nudge to schedule a call',
};

/**
 * POST /api/leads/generate-templates
 *
 * Finds all leads that "need attention" and generates personalized
 * email draft templates using Qwen (free model).
 *
 * Triggers:
 *  1. Stale leads (no contact past threshold)
 *  2. Leads in call_completed with no follow-up sent
 *  3. Demo sent but no feedback
 *  4. Scheduling stalled >48h
 *
 * Returns generated drafts. Stores them in follow_up_queue as pending.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Fetch all active leads with owner info
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, priority, owned_by, last_contact_at, call_completed_at, demo_sent_at, call_summary, next_steps')
    .eq('is_archived', false)
    .not('stage', 'in', '("dead","paused")');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: members } = await supabase.from('team_members').select('id, name, email');
  const nameOf = (id: string) => members?.find(m => m.id === id)?.name || 'there';

  const now = Date.now();
  const templates: TemplateResult[] = [];

  // Find leads that need attention
  const needsAttention: Array<{ lead: typeof leads extends (infer T)[] ? T : never; trigger: string }> = [];

  for (const lead of leads || []) {
    const stage = lead.stage as LeadStage;
    const threshold = STALE_THRESHOLDS[stage];
    const lastContactMs = lead.last_contact_at ? new Date(lead.last_contact_at).getTime() : 0;
    const hoursSince = lastContactMs ? (now - lastContactMs) / 3600000 : Infinity;

    // Trigger 1: Stale in replied/scheduling — needs follow-up
    if (['replied', 'scheduling'].includes(stage) && threshold && hoursSince > threshold) {
      needsAttention.push({ lead, trigger: hoursSince > 72 ? 're_engagement' : 'stale_followup' });
    }
    // Trigger 2: Call completed but no follow-up in >6h
    else if (stage === 'call_completed' && hoursSince > 6) {
      needsAttention.push({ lead, trigger: 'post_call' });
    }
    // Trigger 3: Demo sent, no feedback >3 days
    else if (stage === 'demo_sent' && hoursSince > 72) {
      needsAttention.push({ lead, trigger: 'check_in' });
    }
    // Trigger 4: Scheduling stalled >48h
    else if (stage === 'scheduling' && hoursSince > 48) {
      needsAttention.push({ lead, trigger: 'schedule_nudge' });
    }
  }

  // Limit to top 20 most urgent
  needsAttention.sort((a, b) => {
    const aTime = a.lead.last_contact_at ? new Date(a.lead.last_contact_at).getTime() : 0;
    const bTime = b.lead.last_contact_at ? new Date(b.lead.last_contact_at).getTime() : 0;
    return aTime - bTime; // oldest first = most stale
  });
  const batch = needsAttention.slice(0, 20);

  // Generate templates using Qwen (free)
  for (const { lead, trigger } of batch) {
    const ownerName = nameOf(lead.owned_by);
    const triggerLabel = TEMPLATE_TYPES[trigger] || trigger;

    // Get recent interactions for context
    const { data: recentInteractions } = await supabase
      .from('interactions')
      .select('type, body, subject, occurred_at')
      .eq('lead_id', lead.id)
      .order('occurred_at', { ascending: false })
      .limit(3);

    const threadContext = recentInteractions
      ?.map(i => `[${i.type}] ${i.subject || ''}: ${(i.body || '').slice(0, 200)}`)
      .join('\n') || 'No prior emails.';

    try {
      const result = await callAI({
        model: QWEN_FREE_MODEL,
        systemPrompt: `You are writing a follow-up email for ${ownerName}, a Berkeley student co-founder at Proxi AI (a product prioritization tool for PMs). Write casually but professionally. Be direct. Keep it 2-4 sentences. Sign off with just "${ownerName}".

Context: ${triggerLabel}
${lead.call_summary ? `Call summary: ${lead.call_summary}` : ''}
${lead.next_steps ? `Next steps: ${lead.next_steps}` : ''}

Return valid JSON: { "subject": "...", "body": "..." }`,
        userMessage: `Generate a follow-up email for ${lead.contact_name} at ${lead.company_name}.

Recent thread:
${threadContext}`,
        jsonMode: true,
      });

      if (result) {
        const parsed = JSON.parse(result);
        templates.push({
          lead_id: lead.id,
          contact_name: lead.contact_name,
          company_name: lead.company_name,
          owner: ownerName,
          trigger: triggerLabel,
          subject: parsed.subject || `Following up — ${lead.company_name}`,
          body: parsed.body || '',
        });

        // Store as pending follow-up in queue
        await supabase.from('follow_up_queue').insert({
          lead_id: lead.id,
          team_member_id: lead.owned_by,
          type: 'custom',
          status: 'pending',
          auto_send: false,
          suggested_message: parsed.body || '',
          scheduled_for: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[generate-templates] Failed for ${lead.contact_name} @ ${lead.company_name}:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    success: true,
    leads_needing_attention: needsAttention.length,
    templates_generated: templates.length,
    templates,
  });
}
