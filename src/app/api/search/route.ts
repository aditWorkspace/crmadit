import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

function sanitizeSearch(s: string): string {
  return s.replace(/[,()'"]/g, '').trim();
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = req.nextUrl.searchParams.get('q') || '';
  if (q.length < 2) return NextResponse.json({ leads: [] });

  const safeQ = sanitizeSearch(q);
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, contact_email')
    .or(`contact_name.ilike.%${safeQ}%,company_name.ilike.%${safeQ}%,contact_email.ilike.%${safeQ}%`)
    .eq('is_archived', false)
    .limit(10);

  return NextResponse.json({ leads: data || [] });
}
