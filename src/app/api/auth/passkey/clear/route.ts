import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// DEV ONLY: Clear passkey for a member
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not allowed in production' }, { status: 403 });
  }

  const { memberId } = await req.json();
  if (!memberId) {
    return NextResponse.json({ error: 'memberId required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('team_members')
    .update({
      passkey_credential_id: null,
      passkey_public_key: null,
      passkey_counter: 0,
    })
    .eq('id', memberId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message: 'Passkey cleared' });
}
