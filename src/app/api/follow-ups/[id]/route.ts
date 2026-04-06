import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { addDays } from '@/lib/utils';
import { changeStage } from '@/lib/automation/stage-logic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const body = await req.json();
  const { action, snooze_days, suggested_message } = body;
  const now = new Date().toISOString();

  const supabase = createAdminClient();
  let updates: Record<string, unknown> = {};

  switch (action) {
    case 'complete':
      updates = { status: 'completed', completed_at: now };
      break;
    case 'dismiss':
      updates = { status: 'dismissed', dismissed_at: now };
      break;
    case 'snooze': {
      const days = snooze_days || 1;
      const { data: current } = await supabase.from('follow_up_queue').select('due_at').eq('id', id).single();
      const newDueAt = addDays(current?.due_at ? new Date(current.due_at) : new Date(), days).toISOString();
      updates = { due_at: newDueAt, status: 'pending' };
      break;
    }
    case 'update_message':
      updates = { suggested_message };
      break;
    case 'confirm_call': {
      // Mark confirmation done, then advance lead to call_completed
      updates = { status: 'completed', completed_at: now };
      const { data: fq } = await supabase.from('follow_up_queue').select('lead_id').eq('id', id).single();
      if (fq?.lead_id) {
        await changeStage(fq.lead_id, 'call_completed', session.id);
      }
      break;
    }
    case 'noshow_call': {
      // Dismiss the confirmation — lead stays in scheduled, founders reschedule
      updates = { status: 'dismissed', dismissed_at: now };
      break;
    }
    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('follow_up_queue')
    .update(updates)
    .eq('id', id)
    .select('*, lead:leads(id, contact_name, company_name), assigned_member:team_members(id, name)')
    .single();

  if (error?.code === 'PGRST116') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ follow_up: data });
}
