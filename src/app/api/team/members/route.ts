import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Public — no session required. Used by the user selector modal before login.
export async function GET() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected')
    .order('name');

  if (error) {
    console.error('[team/members]', error);
    return NextResponse.json({ members: [], error: error.message }, { status: 500 });
  }

  return NextResponse.json({ members: data || [] });
}
