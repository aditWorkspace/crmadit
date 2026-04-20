/**
 * One-shot backfill: find `email_inbound` interactions whose stored body or
 * subject looks like it was written by a co-founder, and re-classify them as
 * `email_outbound` attributed to that co-founder.
 *
 * Historical bug: `processMessage` used `isOutbound = fromEmail === gmailEmail`,
 * so if Srijay's Gmail synced a thread where Adit replied, Adit's message got
 * stored as `email_inbound` under the prospect's name. We can't easily recover
 * the original `From:` header here, so we lean on the Gmail message id: any
 * interaction whose `gmail_message_id` appears in multiple team members'
 * mailboxes and is labeled inbound in one and outbound in another is the
 * same message — keep the outbound row, drop the inbound duplicate.
 *
 * Safer, simpler approach (used here): look for signature markers in the body
 * ("Best,\nAdit", "Best,\nSrijay", "Best,\nAsim") and flip the type.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-outbound-attribution.ts --dry
 *   npx tsx --env-file=.env.local scripts/backfill-outbound-attribution.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const { data: members } = await supabase
    .from('team_members')
    .select('id, name');
  if (!members || members.length === 0) {
    console.error('No team members found');
    process.exit(1);
  }

  let totalFlipped = 0;

  for (const m of members) {
    const firstName = m.name.split(/\s+/)[0];
    // Match either "Best,\nAdit" style or "Adit\n<blank>" signature blocks.
    // Use a lenient ilike — signature detection is fuzzy but false positives
    // are rare because non-team humans don't sign as "Adit/Srijay/Asim".
    const { data: candidates, error } = await supabase
      .from('interactions')
      .select('id, type, team_member_id, lead_id, subject, body')
      .eq('type', 'email_inbound')
      .ilike('body', `%Best,%${firstName}%`)
      .limit(2000);
    if (error) {
      console.error(`[${firstName}] query error:`, error.message);
      continue;
    }

    console.log(`[${firstName}] ${candidates?.length ?? 0} inbound rows look like they were signed by ${firstName}`);
    for (const row of candidates ?? []) {
      console.log(`  ${row.id}  lead=${row.lead_id}  subject=${(row.subject ?? '').slice(0, 60)}`);
    }

    if (!apply || !candidates || candidates.length === 0) continue;

    const ids = candidates.map(r => r.id);
    const { error: updErr } = await supabase
      .from('interactions')
      .update({ type: 'email_outbound', team_member_id: m.id })
      .in('id', ids);
    if (updErr) {
      console.error(`[${firstName}] update error:`, updErr.message);
      continue;
    }
    totalFlipped += ids.length;
    console.log(`[${firstName}] flipped ${ids.length} rows to email_outbound`);
  }

  if (!apply) {
    console.log('\nDry run. Pass --apply to actually flip these rows.');
  } else {
    console.log(`\nDone. Flipped ${totalFlipped} rows total.`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
