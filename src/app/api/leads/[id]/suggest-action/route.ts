import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { scoreAndSuggestForLead } from '@/lib/automation/lead-scoring';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    await scoreAndSuggestForLead(id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI scoring failed' }, { status: 500 });
  }

  const supabase = createAdminClient();
  const { data } = await supabase
    .from('leads')
    .select('ai_next_action, ai_next_action_at, heat_score, ai_heat_reason')
    .eq('id', id)
    .single();

  return NextResponse.json(data || {});
}
