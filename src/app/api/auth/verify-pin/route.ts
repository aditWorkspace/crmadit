import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyPin } from '@/lib/auth/pin';

export async function POST(req: NextRequest) {
  const { member_id, pin } = await req.json();
  if (!member_id || !pin) return NextResponse.json({ error: 'member_id and pin required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, name, email, pin_hash')
    .eq('id', member_id)
    .single();

  if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  if (!member.pin_hash) return NextResponse.json({ error: 'No PIN set' }, { status: 400 });

  if (!verifyPin(pin, member.pin_hash)) {
    return NextResponse.json({ error: 'Incorrect PIN' }, { status: 401 });
  }

  return NextResponse.json({ ok: true, member: { id: member.id, name: member.name, email: member.email } });
}
