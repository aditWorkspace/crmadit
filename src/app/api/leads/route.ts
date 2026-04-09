import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { normalizeName } from '@/lib/name-utils';
import { createLeadSchema } from '@/lib/validation';
import { STALE_THRESHOLDS } from '@/lib/constants';

function sanitizeSearch(s: string): string {
  return s.replace(/[,()'"]/g, '').trim();
}

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
    const safeSearch = sanitizeSearch(search);
    query = query.or(
      `contact_name.ilike.%${safeSearch}%,company_name.ilike.%${safeSearch}%,call_notes.ilike.%${safeSearch}%,call_summary.ilike.%${safeSearch}%`
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
    query = query.in('stage', ['call_completed']).is('demo_sent_at', null);
  } else if (preset === 'calls') {
    query = query.in('stage', ['scheduled', 'call_completed', 'feedback_call']);
  } else if (preset === 'snoozed') {
    const now = new Date().toISOString();
    query = query.gt('paused_until', now);
  } else if (preset === 'stale') {
    // Bug #7 fix — use shared STALE_THRESHOLDS from constants (single source of truth)
    const now = Date.now();
    const orParts = Object.entries(STALE_THRESHOLDS)
      .filter(([, hours]) => hours != null)
      .map(([stage, hours]) => {
        const cutoff = new Date(now - (hours as number) * 60 * 60 * 1000).toISOString();
        return `and(stage.eq.${stage},last_contact_at.lt.${cutoff})`;
      })
      .join(',');

    query = query.or(orParts).not('stage', 'in', '("paused","dead")');
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
  const parsed = createLeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map(i => i.message).join(', ') },
      { status: 400 }
    );
  }

  const { contact_name, contact_email, company_name, contact_role, owned_by, sourced_by, ...rest } =
    parsed.data;
  const force = req.nextUrl.searchParams.get('force') === 'true';

  const supabase = createAdminClient();

  // Duplicate detection
  const safeEmail = sanitizeSearch(contact_email);
  const safeName = sanitizeSearch(contact_name);
  const safeCompany = sanitizeSearch(company_name);
  const { data: existing } = await supabase
    .from('leads')
    .select('id, contact_name, company_name')
    .or(
      `contact_email.eq.${safeEmail},and(contact_name.eq.${safeName},company_name.eq.${safeCompany})`
    )
    .eq('is_archived', false)
    .limit(1);

  // Block creation if duplicate found (unless ?force=true)
  if (existing && existing.length > 0 && !force) {
    return NextResponse.json(
      { error: 'A lead with this email or name+company already exists', duplicate: existing[0] },
      { status: 409 }
    );
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      contact_name: normalizeName(contact_name),
      contact_email: contact_email.toLowerCase().trim(),
      company_name: normalizeName(company_name, true),
      contact_role,
      owned_by: owned_by || session.id,
      sourced_by: sourced_by || session.id,
      stage: rest.stage || 'replied',
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

  return NextResponse.json({ lead: data }, { status: 201 });
}
