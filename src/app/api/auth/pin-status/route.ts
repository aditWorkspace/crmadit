import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const memberId = req.nextUrl.searchParams.get('member_id');
  if (!memberId) return NextResponse.json({ error: 'member_id required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data } = await supabase
    .from('team_members')
    .select('pin_hash')
    .eq('id', memberId)
    .single();

  return NextResponse.json({ has_pin: !!data?.pin_hash });
}
