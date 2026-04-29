// Admin endpoint: cancel a pending priority row.
// Cannot cancel rows already scheduled (post runDailyStart) — those are
// in email_send_queue and need per-account pause to halt.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteParams { params: Promise<{ id: string }> }

export async function DELETE(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_priority_queue')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    // Either id doesn't exist or row isn't pending. Distinguish:
    const { data: existing } = await supabase
      .from('email_send_priority_queue')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({
      error: `cannot cancel row in status='${(existing as { status: string }).status}' (only 'pending' rows can be cancelled)`,
    }, { status: 409 });
  }
  return NextResponse.json({ cancelled: data.length });
}
