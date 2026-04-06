import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { ACTIVE_STAGES, STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';
import { differenceInHours } from 'date-fns';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  const [
    { data: actionItems },
    { data: followUps },
    { data: recentActivity },
    { data: allLeads },
    { data: teamMembers },
  ] = await Promise.all([
    supabase
      .from('action_items')
      .select('*, lead:leads(id, contact_name, company_name), assigned_member:team_members(id, name)')
      .eq('assigned_to', session.id)
      .eq('completed', false)
      .order('due_date', { ascending: true })
      .limit(20),
    supabase
      .from('follow_up_queue')
      .select('*, lead:leads(id, contact_name, company_name, stage), assigned_member:team_members(id, name)')
      .eq('assigned_to', session.id)
      .eq('status', 'pending')
      .order('due_at', { ascending: true })
      .limit(15),
    supabase
      .from('activity_log')
      .select('*, team_member:team_members(id, name), lead:leads(id, contact_name, company_name)')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('leads')
      .select('id, stage, owned_by, last_contact_at, our_avg_reply_speed_hrs, time_to_send_demo_hrs, is_archived')
      .eq('is_archived', false),
    supabase
      .from('team_members')
      .select('id, name, gmail_connected'),
  ]);

  // Pipeline stage counts
  const stageCounts: Record<string, number> = {};
  for (const stage of ACTIVE_STAGES) stageCounts[stage] = 0;
  for (const lead of allLeads || []) {
    if (stageCounts[lead.stage] !== undefined) stageCounts[lead.stage]++;
  }

  // Stale leads count
  const now = new Date();
  const staleLeads = (allLeads || []).filter(lead => {
    const threshold = STALE_THRESHOLDS[lead.stage as LeadStage];
    if (!threshold || !lead.last_contact_at) return false;
    return differenceInHours(now, new Date(lead.last_contact_at)) > threshold;
  });

  // Speed scorecard per team member
  const speedByMember: Record<string, { avg_reply: number | null; avg_demo: number | null; active_count: number }> = {};
  for (const member of teamMembers || []) {
    const memberLeads = (allLeads || []).filter(l =>
      l.owned_by === member.id && ACTIVE_STAGES.includes(l.stage as LeadStage)
    );
    const replySpeeds = memberLeads.map(l => l.our_avg_reply_speed_hrs).filter(Boolean) as number[];
    const demoSpeeds = memberLeads.map(l => l.time_to_send_demo_hrs).filter(Boolean) as number[];
    speedByMember[member.id] = {
      avg_reply: replySpeeds.length ? replySpeeds.reduce((a, b) => a + b, 0) / replySpeeds.length : null,
      avg_demo: demoSpeeds.length ? demoSpeeds.reduce((a, b) => a + b, 0) / demoSpeeds.length : null,
      active_count: memberLeads.length,
    };
  }

  return NextResponse.json({
    action_items: actionItems || [],
    follow_ups: followUps || [],
    recent_activity: recentActivity || [],
    stage_counts: stageCounts,
    total_active: (allLeads || []).filter(l => ACTIVE_STAGES.includes(l.stage as LeadStage)).length,
    stale_count: staleLeads.length,
    speed_by_member: speedByMember,
    team_members: teamMembers || [],
  });
}
