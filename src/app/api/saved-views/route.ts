import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('saved_views')
    .select('*')
    .or(`is_shared.eq.true,created_by.eq.${session.id}`)
    .order('name', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ views: data });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, filters, sort_by, sort_dir, is_shared } = await req.json();
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('saved_views')
    .insert({
      name,
      created_by: session.id,
      filters: filters || {},
      sort_by: sort_by || 'updated_at',
      sort_dir: sort_dir || 'desc',
      is_shared: is_shared ?? true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ view: data }, { status: 201 });
}
