import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = (body.reason as string | undefined) ?? 'admin_pause_individual';
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('team_members')
    .update({
      email_send_paused: true,
      email_send_paused_reason: reason,
      email_send_paused_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
