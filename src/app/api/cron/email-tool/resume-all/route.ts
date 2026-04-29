// Admin endpoint: resume all founders' email-send AND reset the global
// crash-counter floor so we get a clean 10-min window post-incident.
// See spec §11.4: "When the admin clicks 'Resume All Sending', the same
// write that flips paused flags off also sets crashes_counter_reset_at
// = now(). The counter restarts cleanly."

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Resume founders + reset crash-counter floor in parallel
  const [tmRes, schRes] = await Promise.all([
    supabase
      .from('team_members')
      .update({
        email_send_paused: false,
        email_send_paused_reason: null,
        email_send_paused_at: null,
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase
      .from('email_send_schedule')
      .update({ crashes_counter_reset_at: now })
      .eq('id', 1),
  ]);

  if (tmRes.error) {
    return NextResponse.json({ error: `team_members: ${tmRes.error.message}` }, { status: 500 });
  }
  if (schRes.error) {
    return NextResponse.json({ error: `email_send_schedule: ${schRes.error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
