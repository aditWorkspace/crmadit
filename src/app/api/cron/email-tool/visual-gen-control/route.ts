// GET  — generation status (enabled, ready/inflight counts, target).
// POST — { action: 'start' | 'stop' } toggles the generator. Admin-only (the
// Start/Stop buttons in the dashboard).
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { READY_TARGET } from '../visual-gen/route';

export const runtime = 'nodejs';

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

const INFLIGHT = ['queued', 'researching', 'verifying_evidence', 'writing', 'checking'];

async function status(supabase: ReturnType<typeof createAdminClient>) {
  const { data: st } = await supabase.from('email_pool_state').select('visual_gen_enabled').eq('id', 1).maybeSingle();
  const cnt = async (statuses: string[]) => {
    const { count } = await supabase.from('cold_email_drafts').select('id', { count: 'exact', head: true }).in('status', statuses);
    return count ?? 0;
  };
  return {
    enabled: !!(st as { visual_gen_enabled?: boolean } | null)?.visual_gen_enabled,
    ready: await cnt(['ready']),
    inflight: await cnt(INFLIGHT),
    target: READY_TARGET,
  };
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  return NextResponse.json(await status(createAdminClient()));
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (action !== 'start' && action !== 'stop') return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
  const supabase = createAdminClient();
  await supabase.from('email_pool_state').update({ visual_gen_enabled: action === 'start' }).eq('id', 1);
  return NextResponse.json(await status(supabase));
}
