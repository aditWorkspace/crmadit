import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Returns the list of team members who have departed (departed_at IS NOT
// NULL). The pipeline owner-legend uses this to render those members'
// dots as grayed-out so historical attribution stays visible while
// signaling that the founder is no longer active.
//
// No session required — this is the same threat surface as /api/team/members
// (the team selector calls that pre-login). Returns names + ids only; no
// secrets or PII beyond what's already public.
export async function GET() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, departed_at')
    .not('departed_at', 'is', null)
    .order('name');

  if (error) {
    console.error('[team/departed]', error);
    return NextResponse.json({ departed: [], error: error.message }, { status: 500 });
  }

  return NextResponse.json({ departed: data ?? [] });
}
