import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const memberId = req.nextUrl.searchParams.get('memberId');
  if (!memberId) {
    return NextResponse.json({ error: 'memberId required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('passkey_credential_id')
    .eq('id', memberId)
    .single();

  return NextResponse.json({
    hasPasskey: !!member?.passkey_credential_id,
  });
}
