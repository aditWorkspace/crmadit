import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const search = searchParams.get('q');
  const stage = searchParams.getAll('stage');
  const priority = searchParams.get('priority');
  const ownedBy = searchParams.get('owned_by');
  const sourcedBy = searchParams.get('sourced_by');
  const pocStatus = searchParams.get('poc_status');
  const preset = searchParams.get('preset'); // 'my_leads', 'awaiting_response', 'awaiting_demo', 'stale'
  const sortBy = searchParams.get('sort_by') || 'updated_at';
  const sortDir = searchParams.get('sort_dir') || 'desc';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  const supabase = createAdminClient();
  let query = supabase
    .from('leads')
    .select(
      `
      *,
      sourced_by_member:team_members!leads_sourced_by_fkey(id, name, email),
      owned_by_member:team_members!leads_owned_by_fkey(id, name, email)
    `,
      { count: 'exact' }
    )
    .eq('is_archived', false);

  // Full-text search (ilike fallback)
  if (search) {
    query = query.or(
      `contact_name.ilike.%${search}%,company_name.ilike.%${search}%,call_notes.ilike.%${search}%,call_summary.ilike.%${search}%`
    );
  }

  // Stage filter
  if (stage.length > 0) {
    query = query.in('stage', stage);
  }

  // Other filters
  if (priority) query = query.eq('priority', priority);
  if (ownedBy) query = query.eq('owned_by', ownedBy);
  if (sourcedBy) query = query.eq('sourced_by', sourcedBy);
  if (pocStatus) query = query.eq('poc_status', pocStatus);

  // Preset filters
  if (preset === 'my_leads') {
    query = query.eq('owned_by', session.id);
  } else if (preset === 'awaiting_response') {
    query = query.in('stage', ['replied']);
  } else if (preset === 'awaiting_demo') {
    query = query.in('stage', ['call_completed', 'post_call']).is('demo_sent_at', null);
  } else if (preset === 'stale') {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    query = query
      .in('stage', ['replied', 'scheduling', 'scheduled', 'call_completed', 'post_call'])
      .lt('last_contact_at', cutoff);
  }

  // Sort
  const validSortCols = [
    'updated_at',
    'created_at',
    'last_contact_at',
    'contact_name',
    'company_name',
    'stage',
    'priority',
    'next_followup_at',
  ];
  const col = validSortCols.includes(sortBy) ? sortBy : 'updated_at';
  query = query.order(col, { ascending: sortDir === 'asc' }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ leads: data, total: count, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { contact_name, contact_email, company_name, contact_role, owned_by, sourced_by, ...rest } =
    body;

  if (!contact_name || !contact_email || !company_name) {
    return NextResponse.json(
      { error: 'contact_name, contact_email, company_name required' },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // Duplicate detection
  const { data: existing } = await supabase
    .from('leads')
    .select('id, contact_name, company_name')
    .or(
      `contact_email.eq.${contact_email},and(contact_name.eq.${contact_name},company_name.eq.${company_name})`
    )
    .eq('is_archived', false)
    .limit(1);

  const { data, error } = await supabase
    .from('leads')
    .insert({
      contact_name,
      contact_email,
      company_name,
      contact_role,
      owned_by: owned_by || session.id,
      sourced_by: sourced_by || session.id,
      stage: 'replied',
      ...rest,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity
  await supabase.from('activity_log').insert({
    lead_id: data.id,
    team_member_id: session.id,
    action: 'lead_created',
    details: { contact_name, company_name },
  });

  return NextResponse.json(
    {
      lead: data,
      duplicate_warning:
        existing && existing.length > 0 ? existing[0] : null,
    },
    { status: 201 }
  );
}
