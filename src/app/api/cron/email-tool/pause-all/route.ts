// Admin endpoint: pause all founders' email-send. The header button
// triggers this for emergency-stop scenarios (e.g., bounce-rate
// emergency, ban scare, mid-campaign pause).
//
// Resume requires explicit admin action via /resume-all (see spec §11.4
// crash-counter floor reset).

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const body = await req.json().catch(() => ({}));
  const reason = (body.reason as string | undefined) ?? 'admin_pause_all';

  const { error } = await supabase
    .from('team_members')
    .update({
      email_send_paused: true,
      email_send_paused_reason: reason,
      email_send_paused_at: new Date().toISOString(),
    })
    .neq('id', '00000000-0000-0000-0000-000000000000'); // idiomatic "all rows"

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
