// Phase -1 of the tick: detect campaigns stuck in status='running' with no
// queue rows ever inserted. Common cause: runDailyStart's claim transaction
// committed the campaign row, then the function timed out / OOM'd / was
// killed before reaching step ⑩'s queue insert. Without this sweep,
// today's campaign is silently forfeited because the self-trigger check
// sees already_started=true and skips, while the drain sees no queue rows
// for today's campaign.
//
// Orphan recovery is intentionally NOT auto-retry. The original failure
// could be deterministic (e.g., a query bug surfaced under prod data
// volume), and auto-retry would loop. Admin must explicitly click
// "Retry today's run" in the Schedule tab UI.

import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';
import { log } from './log';

type Supa = ReturnType<typeof createAdminClient>;

export async function detectAndAbortOrphans(
  supabase: Supa,
  now: Date = new Date(),
): Promise<{ aborted: number }> {
  const cutoff = new Date(
    now.getTime() - SAFETY_LIMITS.ORPHAN_CAMPAIGN_THRESHOLD_MINUTES * 60_000,
  ).toISOString();

  // Find candidates: running campaigns older than cutoff
  const { data: candidates } = await supabase
    .from('email_send_campaigns')
    .select('id, idempotency_key, started_at')
    .eq('status', 'running')
    .lt('started_at', cutoff);

  if (!candidates || candidates.length === 0) return { aborted: 0 };

  const orphans: Array<{ id: string; idempotency_key: string; started_at: string }> = [];
  for (const c of candidates as Array<{ id: string; idempotency_key: string; started_at: string }>) {
    const { count } = await supabase
      .from('email_send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id);
    if ((count ?? 0) === 0) orphans.push(c);
  }

  if (orphans.length === 0) return { aborted: 0 };

  for (const o of orphans) {
    await supabase.from('email_send_campaigns').update({
      status: 'aborted',
      abort_reason: 'orphan_no_queue_rows',
      completed_at: now.toISOString(),
    }).eq('id', o.id);
    await supabase.from('email_send_errors').insert({
      campaign_id: o.id,
      error_class: 'crash',
      error_message: `orphan_campaign_aborted: ${o.idempotency_key}`,
      context: {
        idempotency_key: o.idempotency_key,
        started_at: o.started_at,
        aborted_at: now.toISOString(),
      },
    });
    log('error', 'orphan_aborted', {
      campaign_id: o.id,
      idempotency_key: o.idempotency_key,
    });
  }

  return { aborted: orphans.length };
}
