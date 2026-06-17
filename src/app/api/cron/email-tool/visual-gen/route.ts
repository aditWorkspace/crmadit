// POST /api/cron/email-tool/visual-gen — fired every minute by cron-job.org.
// While generation is ENABLED (Start button), keeps ~READY_TARGET drafts in the
// 'ready' state: seeds the deficit from the top of the pool and triggers the
// draft worker (which researches + generates the image + builds the page). As
// the dashboard sends consume 'ready' drafts, the deficit grows and this tops
// it back up. Stop button flips the flag and this no-ops. CRON_SECRET only.
import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { seedDrafts } from '@/lib/email-tool/visual-seed';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const READY_TARGET = 300;
const SEED_PER_TICK = 60; // cap new drafts started per minute (paces spend + Firecrawl/image concurrency)
const INFLIGHT = ['queued', 'researching', 'verifying_evidence', 'writing', 'checking'];

export async function POST(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const supabase = createAdminClient();

  const { data: st } = await supabase.from('email_pool_state').select('visual_gen_enabled').eq('id', 1).maybeSingle();
  if (!(st as { visual_gen_enabled?: boolean } | null)?.visual_gen_enabled) {
    return NextResponse.json({ ok: true, note: 'paused' });
  }

  const cnt = async (statuses: string[]) => {
    const { count } = await supabase.from('cold_email_drafts').select('id', { count: 'exact', head: true }).in('status', statuses);
    return count ?? 0;
  };
  const ready = await cnt(['ready']);
  const inflight = await cnt(INFLIGHT);

  let seeded = 0;
  const deficit = READY_TARGET - ready - inflight;
  if (deficit > 0) seeded = await seedDrafts(supabase, Math.min(deficit, SEED_PER_TICK));

  // Trigger the worker (fire-and-forget) to drain queued -> ready.
  if (inflight + seeded > 0) {
    const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://pmcrminternal.vercel.app').replace(/\/$/, '');
    after(
      fetch(`${base}/api/cron/email-tool/draft/worker`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {}),
    );
  }

  return NextResponse.json({ ok: true, ready, inflight, seeded, target: READY_TARGET });
}
