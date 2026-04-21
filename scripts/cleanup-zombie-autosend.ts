/**
 * Dismiss `auto_send=true, status=pending, scheduled_for IS NULL` follow-up
 * queue rows. These were created by `scheduling.onEnter` in stage-logic.ts
 * before today's fix and are unreachable by `drainScheduledEmails` (its
 * `WHERE scheduled_for <= now` filter drops NULLs). Their existence also
 * blocks `runAutoFollowup` from queueing a real auto-send for the same lead.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup-zombie-autosend.ts --dry
 *   npx tsx --env-file=.env.local scripts/cleanup-zombie-autosend.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const { data: rows, error } = await supabase
    .from('follow_up_queue')
    .select('id, lead_id, type, created_at')
    .eq('auto_send', true)
    .eq('status', 'pending')
    .is('scheduled_for', null);

  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }

  console.log(`${apply ? 'APPLY' : 'DRY'} — ${rows?.length ?? 0} zombie rows.`);
  for (const r of rows ?? []) {
    console.log(`  ${r.id}  lead=${r.lead_id}  type=${r.type}  created=${r.created_at}`);
  }
  if (!apply || !rows || rows.length === 0) return;

  const ids = rows.map(r => r.id);
  const { error: updErr } = await supabase
    .from('follow_up_queue')
    .update({ status: 'dismissed' })
    .in('id', ids);
  if (updErr) {
    console.error('update error:', updErr.message);
    process.exit(1);
  }
  console.log(`Dismissed ${ids.length} rows.`);
}

main().catch(e => { console.error(e); process.exit(1); });
