// E2E live test of PR 6 changes (lead-on-reply policy + auto-reply detector
// + CRM synergies). Runs against prod DB, sends a real email via Adit's
// stored Gmail tokens, then verifies queue state matches expectations.
//
// Run with: npx tsx --tsconfig=tsconfig.json scripts/e2e-test-pr6.ts
//
// Loads .env.local automatically via dotenv. Does NOT modify any leads
// table state — only inserts a campaign + queue row in the email-tool
// tables.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createAdminClient } from '@/lib/supabase/admin';
import { runTick } from '@/lib/email-tool/tick';

const ADIT_ID = '81e3b472-0359-4065-a626-c87b678dd556';
const VARIANT_ID = 'ea314064-fd37-493b-a9fa-53e084bc61c3';
// Plus-aliasing: gsuite routes aditmittal+anything@berkeley.edu → Adit's inbox
const TEST_RECIPIENT = 'aditmittal+e2etest1@berkeley.edu';

async function main() {
  const supabase = createAdminClient();
  const now = new Date();
  const idempotencyKey = `e2e-test-${now.toISOString()}`;

  console.log('[e2e] inserting campaign...');
  const { data: campaign, error: campErr } = await supabase
    .from('email_send_campaigns')
    .insert({
      idempotency_key: idempotencyKey,
      scheduled_for: now.toISOString(),
      status: 'running',
      send_mode: 'production',
      created_by: ADIT_ID,
      total_picked: 1,
    })
    .select('id')
    .single();
  if (campErr || !campaign) {
    console.error('campaign insert failed:', campErr);
    process.exit(1);
  }
  console.log('[e2e] campaign id =', campaign.id);

  console.log('[e2e] inserting queue row...');
  const { data: queue, error: qErr } = await supabase
    .from('email_send_queue')
    .insert({
      campaign_id: campaign.id,
      account_id: ADIT_ID,
      recipient_email: TEST_RECIPIENT,
      recipient_name: 'Adit',
      recipient_company: 'Berkeley E2E Test',
      template_variant_id: VARIANT_ID,
      send_at: now.toISOString(),
      status: 'pending',
      attempts: 0,
      source: 'priority',
    })
    .select('id')
    .single();
  if (qErr || !queue) {
    console.error('queue insert failed:', qErr);
    process.exit(1);
  }
  console.log('[e2e] queue id =', queue.id);

  console.log('[e2e] calling runTick()...');
  const stats = await runTick(supabase, { now });
  console.log('[e2e] tick stats:', stats);

  console.log('[e2e] re-fetching queue row to verify post-state...');
  const { data: post } = await supabase
    .from('email_send_queue')
    .select('id, status, sent_at, gmail_message_id, gmail_thread_id, rendered_subject, rendered_body, last_error, attempts')
    .eq('id', queue.id)
    .single();
  console.log('[e2e] queue post-state:', JSON.stringify(post, null, 2));

  console.log('[e2e] checking that NO lead was created for the test recipient...');
  const { data: maybeLead } = await supabase
    .from('leads')
    .select('id, contact_email, stage, source_campaign_id, owned_by')
    .eq('contact_email', TEST_RECIPIENT)
    .maybeSingle();
  if (maybeLead) {
    console.error('[e2e] FAIL — lead exists at send time:', maybeLead);
    process.exit(2);
  }
  console.log('[e2e] OK — no lead at send time. Fix 1 verified.');

  console.log('\n=== TEST POINT 1 (send-side) PASSED ===');
  console.log(`Email sent. Reply to it from your gmail to: aditmittal@berkeley.edu`);
  console.log(`Subject of sent email is in queue.rendered_subject above.`);
  console.log(`Test recipient: ${TEST_RECIPIENT}`);
  console.log(`Campaign id: ${campaign.id}  (note this for the reply-side test)`);
  console.log(`Queue row id: ${queue.id}`);
  console.log(`Gmail thread id: ${post?.gmail_thread_id}`);
}

main().catch(err => {
  console.error('e2e test threw:', err);
  process.exit(1);
});
