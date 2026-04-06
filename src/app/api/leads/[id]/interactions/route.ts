import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('interactions')
    .select('*, team_member:team_members(id, name)')
    .eq('lead_id', id)
    .order('occurred_at', { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ interactions: data });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { type, subject, body, occurred_at, metadata } = await req.json();
  if (!type) return NextResponse.json({ error: 'Type required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('interactions')
    .insert({
      lead_id: id,
      team_member_id: session.id,
      type,
      subject,
      body,
      occurred_at: occurred_at || new Date().toISOString(),
      metadata: metadata || {},
    })
    .select('*, team_member:team_members(id, name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ interaction: data }, { status: 201 });
}
