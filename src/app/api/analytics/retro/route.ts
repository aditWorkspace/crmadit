import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest, requireSession } from '@/lib/session';
import { ACTIVE_STAGES, STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';
import { subDays, differenceInHours } from 'date-fns';

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    requireSession(session);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const weekAgo = subDays(new Date(), 7).toISOString();
  const now = new Date();

  const [
    { data: stageChanges, error: scError },
    { data: newLeads, error: nlError },
    { data: allActiveLeads, error: alError },
  ] = await Promise.all([
    // Stage changes in last 7 days
    supabase
      .from('activity_log')
      .select('lead_id, details, created_at, lead:leads(contact_name, company_name)')
      .eq('action', 'stage_changed')
      .gte('created_at', weekAgo)
      .order('created_at', { ascending: false })
      .limit(100),

    // Leads added in last 7 days
    supabase
      .from('leads')
      .select('contact_name, company_name, created_at')
      .gte('created_at', weekAgo)
      .eq('is_archived', false)
      .limit(100),

    // All active non-archived leads (for stale detection + count)
    supabase
      .from('leads')
      .select('id, contact_name, company_name, stage, last_contact_at')
      .in('stage', ACTIVE_STAGES)
      .eq('is_archived', false),
  ]);

  if (scError || nlError || alError) {
    return NextResponse.json(
      { error: scError?.message || nlError?.message || alError?.message },
      { status: 500 }
    );
  }

  // Moved forward (exclude dead/paused destinations)
  const leadsMovedForward = (stageChanges || [])
    .filter((a) => {
      const to = (a.details as { to?: string } | null)?.to;
      return to && to !== 'dead' && to !== 'paused';
    })
    .map((a) => {
      const lead = a.lead as { contact_name?: string; company_name?: string } | null;
      const details = a.details as { from?: string; to?: string } | null;
      return {
        contact_name: lead?.contact_name ?? 'Unknown',
        company_name: lead?.company_name ?? '',
        from_stage: details?.from ?? '',
        to_stage: details?.to ?? '',
      };
    });

  // Stale leads
  const staleLeads = (allActiveLeads || [])
    .filter((l) => {
      const threshold = STALE_THRESHOLDS[l.stage as LeadStage];
      if (!threshold || !l.last_contact_at) return false;
      return differenceInHours(now, new Date(l.last_contact_at)) > threshold;
    })
    .map((l) => ({
      contact_name: l.contact_name,
      company_name: l.company_name,
      stage: l.stage,
      hours_stale: Math.round(
        differenceInHours(now, new Date(l.last_contact_at!))
      ),
    }));

  return NextResponse.json({
    leads_moved_forward: leadsMovedForward,
    new_leads: (newLeads || []).map((l) => ({
      contact_name: l.contact_name,
      company_name: l.company_name,
    })),
    stale_leads: staleLeads,
    total_active: (allActiveLeads || []).length,
  });
}
