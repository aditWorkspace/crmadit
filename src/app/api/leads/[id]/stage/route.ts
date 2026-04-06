import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { LeadStage } from '@/types';

const VALID_STAGES: LeadStage[] = [
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'active_user',
  'paused',
  'dead',
];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { stage } = await req.json();
  if (!VALID_STAGES.includes(stage)) {
    return NextResponse.json({ error: 'Invalid stage' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: lead } = await supabase.from('leads').select('*').eq('id', id).single();
  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Validation: scheduled requires call_scheduled_for
  if (stage === 'scheduled' && !lead.call_scheduled_for) {
    return NextResponse.json(
      { error: 'Must set a call date/time before marking as scheduled', code: 'VALIDATION_FAILED' },
      { status: 422 }
    );
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { stage, updated_at: now };

  // Auto-fill timestamps
  if (stage === 'replied' && !lead.first_reply_at) updates.first_reply_at = now;
  if (stage === 'call_completed' && !lead.call_completed_at) updates.call_completed_at = now;
  if (stage === 'demo_sent' && !lead.demo_sent_at) updates.demo_sent_at = now;
  if (stage === 'active_user' && !lead.product_access_granted_at) updates.product_access_granted_at = now;

  await supabase.from('leads').update(updates).eq('id', id);
  await supabase.from('activity_log').insert({
    lead_id: id,
    team_member_id: session.id,
    action: 'stage_changed',
    details: { from: lead.stage, to: stage },
  });
  await supabase.from('interactions').insert({
    lead_id: id,
    team_member_id: session.id,
    type: 'stage_change',
    body: `Stage changed from ${lead.stage} to ${stage}`,
    occurred_at: now,
  });

  return NextResponse.json({ success: true, stage });
}
