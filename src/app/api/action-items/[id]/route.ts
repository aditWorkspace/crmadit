import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const body = await req.json();
  const { id: _id, lead_id: _lid, created_at: _ca, ...updates } = body;

  const now = new Date().toISOString();
  if (updates.completed === true && !updates.completed_at) {
    updates.completed_at = now;
  }
  if (updates.completed === false) {
    updates.completed_at = null;
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('action_items')
    .update(updates)
    .eq('id', id)
    .select('*, assigned_member:team_members(id, name)')
    .single();

  if (error?.code === 'PGRST116') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ action_item: data });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { error } = await supabase.from('action_items').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
