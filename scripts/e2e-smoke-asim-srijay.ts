// Final pre-launch smoke test. Sends 1 real email from each of Asim and
// Srijay to plus-aliased addresses that route to Adit's inbox so the
// operator can visually confirm both inbox arrivals + render quality.
//
// Run with: npx tsx --tsconfig=tsconfig.json scripts/e2e-smoke-asim-srijay.ts

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createAdminClient } from '@/lib/supabase/admin';
import { runTick } from '@/lib/email-tool/tick';

const ASIM_ID = '63f0df4a-a75e-4871-8e01-66d474ee47e2';
const SRIJAY_ID = '819ef9cd-d35d-4926-8475-1fe1940da742';

async function smoke(founderId: string, founderLabel: string, recipient: string) {
  const supabase = createAdminClient();
  const now = new Date();

  console.log(`\n[${founderLabel}] looking up active variant...`);
  const { data: variantRow } = await supabase
    .from('email_template_variants')
    .select('id, label')
    .eq('founder_id', founderId)
    .eq('is_active', true)
    .maybeSingle();
  if (!variantRow) {
    console.error(`[${founderLabel}] FAIL — no active variant`);
    process.exit(2);
  }
  const variantId = (variantRow as { id: string; label: string }).id;
  console.log(`[${founderLabel}] variant id = ${variantId} (${(variantRow as {label: string}).label})`);

  console.log(`[${founderLabel}] inserting campaign...`);
  const { data: campaign, error: campErr } = await supabase
    .from('email_send_campaigns')
    .insert({
      idempotency_key: `smoke-${founderLabel}-${now.toISOString()}`,
      scheduled_for: now.toISOString(),
      status: 'running',
      send_mode: 'production',
      created_by: founderId,
      total_picked: 1,
    })
    .select('id')
    .single();
  if (campErr || !campaign) {
    console.error(`[${founderLabel}] campaign insert failed:`, campErr);
    process.exit(2);
  }

  console.log(`[${founderLabel}] inserting queue row → ${recipient}`);
  const { data: queue, error: qErr } = await supabase
    .from('email_send_queue')
    .insert({
      campaign_id: campaign.id,
      account_id: founderId,
      recipient_email: recipient,
      recipient_name: 'Adit',
      recipient_company: `${founderLabel} smoke test`,
      template_variant_id: variantId,
      send_at: now.toISOString(),
      status: 'pending',
      attempts: 0,
      source: 'priority',
    })
    .select('id')
    .single();
  if (qErr || !queue) {
    console.error(`[${founderLabel}] queue insert failed:`, qErr);
    process.exit(2);
  }

  console.log(`[${founderLabel}] runTick()...`);
  const stats = await runTick(supabase, { now });
  console.log(`[${founderLabel}] tick stats:`, stats);

  const { data: post } = await supabase
    .from('email_send_queue')
    .select('status, gmail_message_id, gmail_thread_id, rendered_subject, last_error')
    .eq('id', queue.id)
    .single();
  console.log(`[${founderLabel}] post:`, JSON.stringify(post));

  if ((post as { status: string } | null)?.status !== 'sent') {
    console.error(`[${founderLabel}] FAIL — status is not 'sent'`);
    process.exit(2);
  }

  // No-lead-at-send-time check
  const { data: maybeLead } = await supabase
    .from('leads')
    .select('id')
    .eq('contact_email', recipient)
    .maybeSingle();
  if (maybeLead) {
    console.error(`[${founderLabel}] FAIL — lead exists at send time`);
    process.exit(2);
  }
  console.log(`[${founderLabel}] OK — sent + no lead created at send time.`);
}

async function main() {
  await smoke(ASIM_ID, 'Asim', 'aditmittal+asimsmoke@berkeley.edu');
  await smoke(SRIJAY_ID, 'Srijay', 'aditmittal+srijaysmoke@berkeley.edu');
  console.log('\n=== ALL THREE FOUNDERS PROVEN END-TO-END (Adit earlier, Asim + Srijay just now) ===');
}

main().catch(err => {
  console.error('smoke threw:', err);
  process.exit(1);
});
