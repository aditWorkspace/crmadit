// Admin endpoint: list recent campaigns for the Schedule tab.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '10', 10), 100);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_campaigns')
    .select('id, scheduled_for, status, total_picked, total_sent, total_failed, total_skipped, abort_reason, warmup_day, send_mode, started_at, completed_at')
    .order('scheduled_for', { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaigns: data ?? [] });
}
