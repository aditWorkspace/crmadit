import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  const { data: emails } = await supabase
    .from('interactions')
    .select(`
      id, type, subject, body, summary, occurred_at, gmail_thread_id,
      lead:leads(id, contact_name, company_name, stage, owned_by),
      team_member:team_members(id, name)
    `)
    .eq('type', 'email_inbound')
    .order('occurred_at', { ascending: false })
    .limit(50);

  return NextResponse.json({ emails: emails || [] });
}
