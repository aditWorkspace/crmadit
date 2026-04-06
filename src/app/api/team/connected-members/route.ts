import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected')
    .eq('gmail_connected', true)
    .order('name');

  return NextResponse.json({ members: data || [] });
}
