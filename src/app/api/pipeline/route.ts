import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { ACTIVE_STAGES, STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const filter = searchParams.get('filter') || 'all'; // all | mine | calls | demos | weekly

  const supabase = createAdminClient();

  // 1. Fetch active leads
  let query = supabase
    .from('leads')
    .select(`
      id, contact_name, contact_email, contact_role, contact_linkedin,
      company_name, company_url, company_stage, company_size,
      owned_by, sourced_by, call_participants,
      stage, priority, heat_score,
      ai_next_action, ai_heat_reason,
      first_reply_at, call_scheduled_for, call_completed_at, demo_sent_at,
      product_access_granted_at, last_contact_at, next_followup_at,
      call_prep_notes, call_prep_status, call_prep_generated_at,
      call_summary, call_notes, next_steps,
      tags, poc_status, poc_notes,
      paused_until, paused_previous_stage, pinned_note,
      is_archived, created_at, updated_at,
      owned_by_member:team_members!leads_owned_by_fkey(id, name, email)
    `)
    .eq('is_archived', false)
    .in('stage', [...ACTIVE_STAGES, 'paused']);

  if (filter === 'mine') query = query.eq('owned_by', session.id);
  if (filter === 'calls') query = query.in('stage', ['scheduled', 'call_completed']);
  if (filter === 'demos') query = query.in('stage', ['demo_sent', 'feedback_call']);
  if (filter === 'weekly') query = query.in('stage', ['active_user']);

  const { data: leads, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!leads || leads.length === 0) return NextResponse.json({ leads: [] });

  // 2. Fetch last interaction per lead (one query, group client-side)
  const leadIds = leads.map((l) => l.id);
  const { data: interactions } = await supabase
    .from('interactions')
    .select('lead_id, type, subject, body, summary, occurred_at, gmail_thread_id')
    .in('lead_id', leadIds)
    .in('type', ['email_inbound', 'email_outbound', 'note'])
    .order('occurred_at', { ascending: false });

  const lastInteractionByLead: Record<string, { type: string; subject: string | null; body: string | null; summary: string | null; occurred_at: string; gmail_thread_id: string | null }> = {};
  for (const i of interactions || []) {
    if (!lastInteractionByLead[i.lead_id]) lastInteractionByLead[i.lead_id] = i;
  }

  // Also grab the latest gmail thread per lead (for compose bar)
  const latestThreadByLead: Record<string, { threadId: string; subject: string }> = {};
  for (const i of interactions || []) {
    if (i.gmail_thread_id && !latestThreadByLead[i.lead_id]) {
      latestThreadByLead[i.lead_id] = { threadId: i.gmail_thread_id, subject: i.subject || '' };
    }
  }

  // 3. Compute urgency group for each lead
  const now = Date.now();
  function urgencyGroup(stage: LeadStage, lastContactAt: string | null): 'needs_attention' | 'calls' | 'active' | 'long_term' | 'paused' {
    if (stage === 'paused') return 'paused';
    if (stage === 'scheduled' || stage === 'call_completed') return 'calls';
    if (stage === 'feedback_call' || stage === 'active_user') return 'long_term';
    if (!lastContactAt) return 'active';
    const threshold = STALE_THRESHOLDS[stage];
    if (!threshold) return 'active';
    const hoursSince = (now - new Date(lastContactAt).getTime()) / (1000 * 3600);
    return hoursSince > threshold ? 'needs_attention' : 'active';
  }

  const enriched = leads.map((lead) => ({
    ...lead,
    last_interaction: lastInteractionByLead[lead.id] || null,
    latest_thread: latestThreadByLead[lead.id] || null,
    urgency_group: urgencyGroup(lead.stage as LeadStage, lead.last_contact_at),
  }));

  // Sort: needs_attention first (most stale at top), then calls, then active, then long_term, then paused
  const GROUP_ORDER = ['needs_attention', 'calls', 'active', 'long_term', 'paused'];
  enriched.sort((a, b) => {
    const gi = GROUP_ORDER.indexOf(a.urgency_group) - GROUP_ORDER.indexOf(b.urgency_group);
    if (gi !== 0) return gi;
    // Within group: most stale / most recently active
    const aTime = a.last_contact_at ? new Date(a.last_contact_at).getTime() : 0;
    const bTime = b.last_contact_at ? new Date(b.last_contact_at).getTime() : 0;
    if (a.urgency_group === 'needs_attention') return aTime - bTime; // most stale first
    return bTime - aTime; // most recent first for others
  });

  return NextResponse.json({ leads: enriched });
}
