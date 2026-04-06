import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashPin } from '@/lib/auth/pin';

export async function POST(req: NextRequest) {
  const { member_id, pin, reset } = await req.json();
  if (!member_id) return NextResponse.json({ error: 'member_id required' }, { status: 400 });

  const supabase = createAdminClient();

  if (reset) {
    // Clear PIN — next login will prompt to create one
    const { error } = await supabase.from('team_members').update({ pin_hash: null }).eq('id', member_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (!pin || !/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: 'PIN must be 4 digits' }, { status: 400 });
  }

  const { error } = await supabase.from('team_members').update({ pin_hash: hashPin(pin) }).eq('id', member_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
