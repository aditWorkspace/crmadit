/**
 * One-shot: run the inbox-triage classifier over every `email_inbound`
 * interaction that doesn't yet have triage metadata, and persist the result.
 *
 * Respects rate limits: processes in batches of 25, sleeps 1.5s between
 * batches. Takes a few minutes for a few hundred rows.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-inbox-triage.ts --dry
 *   npx tsx --env-file=.env.local scripts/backfill-inbox-triage.ts --apply
 *   npx tsx --env-file=.env.local scripts/backfill-inbox-triage.ts --apply --limit 50
 */

import { createClient } from '@supabase/supabase-js';
import { triageInboundEmail } from '../src/lib/ai/inbox-triage';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitIdx = args.indexOf('--limit');
  const totalLimit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 2000;

  console.log(`${apply ? 'APPLY' : 'DRY'} mode. Up to ${totalLimit} rows.`);

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, lead_id, subject, body, gmail_thread_id, metadata, occurred_at')
    .eq('type', 'email_inbound')
    .order('occurred_at', { ascending: false })
    .limit(totalLimit);

  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }

  const pending = (rows ?? []).filter(r => {
    const m = (r.metadata ?? {}) as { triage?: { brief?: string } };
    if (!m.triage) return true;
    // Reclassify rows that landed on the classifier fallback so we get a
    // real signal once the upstream model is working.
    return m.triage.brief === 'classifier fallback';
  });

  console.log(`${pending.length} rows need triage (skipping ${(rows?.length ?? 0) - pending.length} already classified).`);

  if (!apply) {
    pending.slice(0, 10).forEach(r => {
      console.log(`  ${r.id}  "${(r.subject ?? '').slice(0, 60)}"`);
    });
    console.log('\nDry run. Pass --apply to actually classify and persist.');
    return;
  }

  const BATCH = 10;
  const SLEEP_MS = 1200;
  let done = 0;
  let flipped = 0;
  let knowledgeHits = 0;

  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);

    const results = await Promise.all(
      slice.map(async r => {
        // Prior outbound for thread context
        let priorOutbound: string | null = null;
        if (r.gmail_thread_id) {
          const { data: prior } = await supabase
            .from('interactions')
            .select('body')
            .eq('gmail_thread_id', r.gmail_thread_id)
            .eq('type', 'email_outbound')
            .lt('occurred_at', r.occurred_at)
            .order('occurred_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          priorOutbound = prior?.body ?? null;
        }

        const { data: lead } = await supabase
          .from('leads')
          .select('stage, contact_name, company_name')
          .eq('id', r.lead_id)
          .maybeSingle();

        const triage = await triageInboundEmail({
          inboundSubject: r.subject ?? '',
          inboundBody: r.body ?? '',
          priorOutboundBody: priorOutbound,
          leadStage: lead?.stage ?? null,
          contactName: lead?.contact_name ?? null,
          companyName: lead?.company_name ?? null,
        });

        return { id: r.id, leadContext: lead, triage };
      }),
    );

    for (const { id, leadContext, triage } of results) {
      const nextMetadata = {
        triage: {
          needs_response: triage.needs_response,
          reason: triage.reason,
          brief: triage.brief,
        },
      };

      const { error: updErr } = await supabase
        .from('interactions')
        .update({ metadata: nextMetadata })
        .eq('id', id);
      if (updErr) {
        console.error(`  update ${id} failed:`, updErr.message);
        continue;
      }

      if (triage.knowledge) {
        const when = new Date().toISOString().slice(0, 10);
        const who = [leadContext?.contact_name, leadContext?.company_name].filter(Boolean).join(' @ ') || 'email';
        const snippet = `\n---\n### ${when} — ${who} (inbox backfill)\n- ${triage.knowledge.snippet}\n`;
        await supabase.rpc('append_knowledge_doc', {
          p_doc_type: triage.knowledge.type,
          p_content: snippet,
        });
        knowledgeHits++;
      }

      if (!triage.needs_response) flipped++;
      done++;
    }

    console.log(`  batch ${Math.floor(i / BATCH) + 1}: processed ${done}/${pending.length}, ${flipped} marked needs_response=false, ${knowledgeHits} knowledge snippets`);
    if (i + BATCH < pending.length) await sleep(SLEEP_MS);
  }

  console.log(`\nDone. Processed ${done}. Marked ${flipped} as needs_response=false. Added ${knowledgeHits} knowledge snippets.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
