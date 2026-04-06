import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const status = searchParams.get('status'); // 'pending', 'sent', 'completed', 'dismissed'
  const assignedTo = searchParams.get('assigned_to');
  const leadId = searchParams.get('lead_id');

  const supabase = createAdminClient();
  let query = supabase
    .from('follow_up_queue')
    .select(`
      *,
      lead:leads(id, contact_name, company_name, stage),
      assigned_member:team_members(id, name)
    `)
    .order('due_at', { ascending: true });

  if (status) query = query.eq('status', status);
  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  if (leadId) query = query.eq('lead_id', leadId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ follow_ups: data });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { lead_id, type, reason, suggested_message, due_at, assigned_to, auto_send } = await req.json();
  if (!lead_id || !type || !due_at) {
    return NextResponse.json({ error: 'lead_id, type, and due_at are required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('follow_up_queue')
    .insert({
      lead_id,
      type,
      reason,
      suggested_message,
      due_at,
      assigned_to: assigned_to || session.id,
      auto_send: auto_send ?? false,
      status: 'pending',
    })
    .select('*, lead:leads(id, contact_name, company_name, stage), assigned_member:team_members(id, name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ follow_up: data }, { status: 201 });
}
