import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const category = req.nextUrl.searchParams.get('category');
  const supabase = createAdminClient();

  let query = supabase
    .from('email_templates')
    .select('*')
    .order('usage_count', { ascending: false });

  if (category) query = query.eq('category', category);

  // Show shared templates + user's own
  query = query.or(`is_shared.eq.true,created_by.eq.${session.id}`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ templates: data });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, subject, body, category, is_shared } = await req.json();
  if (!name || !body) {
    return NextResponse.json({ error: 'name and body are required' }, { status: 400 });
  }

  const validCategories = ['post_call', 'post_demo', 'check_in', 'booking', 'custom'];
  if (category && !validCategories.includes(category)) {
    return NextResponse.json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_templates')
    .insert({
      name,
      subject: subject || '',
      body,
      category: category || 'custom',
      created_by: session.id,
      is_shared: is_shared ?? true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data }, { status: 201 });
}
