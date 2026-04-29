// Admin endpoint: skip the next scheduled campaign run.
// Sets email_send_schedule.skip_next_run = body.skip (default true).
// The next time the tick handler self-triggers, it will skip and
// advance last_run_at without inserting any queue rows.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const value = body.skip ?? true;
  if (typeof value !== 'boolean') {
    return NextResponse.json({ error: 'skip must be boolean' }, { status: 400 });
  }
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('email_send_schedule')
    .update({ skip_next_run: value, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, skip_next_run: value });
}
