/**
 * Backfill `metadata.rfc_message_id` on existing inbound interactions so that
 * the first reply to any *current* thread lands in the same Gmail thread
 * instead of spawning a new one. Without this, only threads that receive a
 * fresh inbound after the fix goes live will thread correctly.
 *
 * Strategy: for each `email_inbound` row missing rfc_message_id, fetch the
 * Gmail message via the owning team member's Gmail API and copy the real
 * Message-Id header into metadata.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-rfc-message-id.ts --dry
 *   npx tsx --env-file=.env.local scripts/backfill-rfc-message-id.ts --apply
 *   npx tsx --env-file=.env.local scripts/backfill-rfc-message-id.ts --apply --limit 100
 */

import { createClient } from '@supabase/supabase-js';
import { getGmailClientForMember } from '../src/lib/gmail/client';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 800;

  console.log(`${apply ? 'APPLY' : 'DRY'} mode. Up to ${limit} inbound rows.`);

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, team_member_id, gmail_message_id, metadata, occurred_at, subject')
    .eq('type', 'email_inbound')
    .not('gmail_message_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }

  const pending = (rows ?? []).filter(r => {
    const m = (r.metadata ?? {}) as { rfc_message_id?: string };
    return !m.rfc_message_id;
  });

  console.log(`${pending.length} rows missing rfc_message_id.`);
  if (!apply) {
    pending.slice(0, 5).forEach(r =>
      console.log(`  ${r.id}  ${r.team_member_id}  "${(r.subject ?? '').slice(0, 50)}"`),
    );
    return;
  }

  let done = 0;
  let updated = 0;
  let notFound = 0;

  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async row => {
        done++;
        try {
          const { gmail } = await getGmailClientForMember(row.team_member_id);
          const res = await gmail.users.messages.get({
            userId: 'me',
            id: row.gmail_message_id!,
            format: 'metadata',
            metadataHeaders: ['Message-Id'],
          });
          const header = (res.data.payload?.headers || []).find(
            h => h.name?.toLowerCase() === 'message-id',
          );
          const raw = header?.value?.trim();
          if (!raw) {
            notFound++;
            return;
          }
          const normalized = raw.startsWith('<') ? raw.split(/\s+/)[0] : `<${raw.split(/\s+/)[0]}>`;

          const nextMetadata = {
            ...((row.metadata ?? {}) as Record<string, unknown>),
            rfc_message_id: normalized,
          };

          const { error: updErr } = await supabase
            .from('interactions')
            .update({ metadata: nextMetadata })
            .eq('id', row.id);

          if (updErr) {
            console.error(`  update ${row.id} failed:`, updErr.message);
            return;
          }
          updated++;
        } catch (err) {
          notFound++;
          console.error(`  gmail fetch for ${row.id} failed:`, err instanceof Error ? err.message : err);
        }
      }),
    );
    console.log(`  progress ${done}/${pending.length}, updated ${updated}, notFound ${notFound}`);
    if (i + BATCH < pending.length) await sleep(400);
  }

  console.log(`\nDone. Updated ${updated}. Not found / errored: ${notFound}.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
