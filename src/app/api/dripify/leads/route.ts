// GET /api/dripify/leads
// Session-required list endpoint for the /dripify UI table.
//
// Query params:
//   status — filter by single status (or "all" to disable). Default: all.
//   q      — fuzzy search over first_name/last_name/company_name/resolved_email/linkedin_url
//   limit  — default 100, max 500
//
// Sorted by created_at DESC (newest first).

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'all';
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);

  const supabase = createAdminClient();
  let query = supabase
    .from('dripify_leads')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (q.length > 0) {
    // ilike across 5 columns. Supabase's `.or()` lets us chain these without
    // dropping to raw SQL.
    const pattern = `%${q}%`;
    query = query.or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},company_name.ilike.${pattern},resolved_email.ilike.${pattern},linkedin_url.ilike.${pattern}`,
    );
  }

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Status counts (separate query so search/status filter don't affect them).
  const { data: statusCountsData } = await supabase
    .from('dripify_leads')
    .select('status');
  const counts: Record<string, number> = {};
  for (const row of (statusCountsData ?? []) as Array<{ status: string }>) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }

  return NextResponse.json({ leads: data ?? [], total: count ?? 0, counts });
}
