import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('action_items')
    .select('*, assigned_member:team_members(id, name)')
    .eq('lead_id', id)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ action_items: data });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { text, assigned_to, due_date, source } = await req.json();
  if (!text?.trim()) return NextResponse.json({ error: 'Text required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('action_items')
    .insert({ lead_id: id, text: text.trim(), assigned_to, due_date, source: source || 'manual' })
    .select('*, assigned_member:team_members(id, name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ action_item: data }, { status: 201 });
}
