/**
 * One-shot cleanup: delete existing calendar-notification interactions that
 * were synced before the Path 0 filter shipped. Safe — only matches subject
 * prefixes that are unambiguously calendar-system emails.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup-calendar-noise.ts --dry
 *   npx tsx --env-file=.env.local scripts/cleanup-calendar-noise.ts --delete
 */

import { createClient } from '@supabase/supabase-js';

const SUBJECT_PATTERNS = [
  'Invitation:%',
  'Updated invitation:%',
  'Accepted:%',
  'Declined:%',
  'Tentatively accepted:%',
  'Tentative:%',
  'Canceled event:%',
  'Cancelled event:%',
  'Canceled:%',
  'Cancelled:%',
  'Rescheduled event:%',
];

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--delete');

  const orClause = SUBJECT_PATTERNS.map(p => `subject.ilike.${p}`).join(',');
  const { data, error } = await supabase
    .from('interactions')
    .select('id, subject, type, lead_id, occurred_at')
    .in('type', ['email_inbound', 'email_outbound', 'other'])
    .or(orClause)
    .limit(500);

  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }

  console.log(`Matched ${data?.length ?? 0} calendar-noise interactions`);
  for (const row of data ?? []) {
    console.log(`  [${row.type}] ${row.occurred_at}  ${row.subject}`);
  }

  if (dryRun) {
    console.log('\nDry run — pass --delete to actually remove these rows.');
    return;
  }

  const ids = (data ?? []).map(r => r.id);
  if (ids.length === 0) {
    console.log('Nothing to delete.');
    return;
  }
  const { error: delErr } = await supabase.from('interactions').delete().in('id', ids);
  if (delErr) {
    console.error('delete error:', delErr.message);
    process.exit(1);
  }
  console.log(`Deleted ${ids.length} rows.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
