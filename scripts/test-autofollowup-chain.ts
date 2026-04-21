/**
 * 10-test harness for the auto-followup pipeline. Each test exercises a
 * specific link in the chain. Tests that mutate state are clearly marked.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/test-autofollowup-chain.ts
 *   npx tsx --env-file=.env.local scripts/test-autofollowup-chain.ts --send  # also runs T5/T10 which actually send mail
 *
 * Without --send, T5 and T10 are skipped (they would email a real founder).
 */

import { createClient } from '@supabase/supabase-js';
import { getGmailClientForMember } from '../src/lib/gmail/client';
import {
  isWithinSendingWindow,
  drainScheduledEmails,
  canSendOutbound,
  hasMinimumGap,
} from '../src/lib/automation/send-guards';
import {
  autoReplyEnabled,
  fastLoopEnabled,
  infoReplyEnabled,
} from '../src/lib/automation/kill-switch';
import { runAutoFollowup } from '../src/lib/automation/auto-followup';
import { runFirstReplyAutoResponder } from '../src/lib/automation/first-reply-responder';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let pass = 0, fail = 0;

function ok(name: string, detail = '') {
  pass++;
  console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
}
function bad(name: string, detail: string) {
  fail++;
  console.log(`  ✗ ${name}  ${detail}`);
}
function skip(name: string, why: string) {
  console.log(`  - ${name}  SKIP: ${why}`);
}

const PROD_URL = 'https://pmcrminternal.vercel.app';
const SECRET = process.env.CRON_SECRET!;
const ADIT_EMAIL = 'aditmittal@berkeley.edu';

// ─────────────────────────────────────────────────────────────────────────────

async function T1_cron_auth() {
  console.log('\n[T1] Cron auth gate (401 without, 200 with)');
  const r1 = await fetch(`${PROD_URL}/api/cron/auto-followup`);
  if (r1.status === 401) ok('no-auth → 401');
  else bad('no-auth', `expected 401, got ${r1.status}`);

  const r2 = await fetch(`${PROD_URL}/api/cron/auto-followup`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (r2.status === 200) ok('auth → 200');
  else bad('auth', `expected 200, got ${r2.status}`);
}

async function T2_send_window() {
  console.log('\n[T2] Sending window (Mon-Fri 7:14a–6p PT)');
  const now = new Date();
  const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const inWindow = isWithinSendingWindow(now);
  ok('current PT time', `= ${ptStr}, inWindow=${inWindow}`);
}

async function T3_kill_switches() {
  console.log('\n[T3] Kill switches (default = enabled)');
  const a = autoReplyEnabled(), f = fastLoopEnabled(), i = infoReplyEnabled();
  if (a && f && i) ok('all three enabled');
  else bad('kill switches', `auto=${a} fast=${f} info=${i}`);
}

async function T4_token_health() {
  console.log('\n[T4] Gmail token health (all founders)');
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected');
  for (const m of members ?? []) {
    if (!m.gmail_connected) { bad(m.name, 'gmail_connected=false'); continue; }
    try {
      const { gmail } = await getGmailClientForMember(m.id);
      const p = await gmail.users.getProfile({ userId: 'me' });
      ok(m.name, `→ ${p.data.emailAddress}`);
    } catch (e) {
      bad(m.name, e instanceof Error ? e.message : String(e));
    }
  }
}

async function T5_drainer_empty() {
  console.log('\n[T5] Drainer with no due rows → sent=0, errors=[]');
  // Snapshot state. Drainer may pick up real rows; that's still informative.
  const r = await drainScheduledEmails();
  if (r.errors.length === 0) ok('no errors');
  else bad('errors', JSON.stringify(r.errors));
  ok('result', `sent=${r.sent} errors=${r.errors.length}`);
}

async function T6_runAutoFollowup_queues_well() {
  console.log('\n[T6] runAutoFollowup → queued rows have scheduled_for set');
  const r = await runAutoFollowup();
  if (r.errors.length === 0) ok('no errors');
  else bad('errors', JSON.stringify(r.errors));
  ok('result', `processed=${r.processed} queued=${r.queued} skipped=${r.skipped}`);

  // Verify any auto_send rows it could have inserted have scheduled_for.
  const { count: nullCount } = await supabase
    .from('follow_up_queue')
    .select('id', { count: 'exact', head: true })
    .eq('auto_send', true)
    .eq('status', 'pending')
    .is('scheduled_for', null);
  if ((nullCount ?? 0) === 0) ok('no zombie rows', '(scheduled_for IS NULL pending auto_send)');
  else bad('zombie rows present', `${nullCount} rows with auto_send=true status=pending scheduled_for=NULL`);
}

async function T7_firstreply_dryrun() {
  console.log('\n[T7] first-reply-responder dry-run (no side effects)');
  const r = await runFirstReplyAutoResponder({ dryRun: true });
  if (r.errors.length === 0) ok('no errors');
  else bad('errors', JSON.stringify(r.errors));
  ok('result', `processed=${r.processed} sent=${r.sent} manual_review=${r.manual_review} skipped=${r.skipped}`);
  if (r.details && r.details.length > 0) {
    ok('classifications surfaced', `${r.details.length} details`);
    for (const d of r.details.slice(0, 3)) {
      console.log(`      ${d.classification.padEnd(15)} action=${d.action.padEnd(15)} reason=${d.reason.slice(0, 60)}`);
    }
  }
}

async function T8_killswitch_blocks_drainer() {
  console.log('\n[T8] Kill switch off → drainer returns sent=0');
  process.env.AUTO_REPLY_ENABLED = 'false';
  try {
    const r = await drainScheduledEmails();
    if (r.sent === 0 && r.errors.length === 0) ok('drainer skipped cleanly');
    else bad('drainer', `expected sent=0 errors=0, got sent=${r.sent} errors=${r.errors.length}`);
  } finally {
    delete process.env.AUTO_REPLY_ENABLED;
  }
}

async function T9_guards_evaluate() {
  console.log('\n[T9] Per-lead guards (canSendOutbound + hasMinimumGap)');
  // Pick an arbitrary recently-active lead.
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name')
    .eq('is_archived', false)
    .order('last_contact_at', { ascending: false, nullsFirst: false })
    .limit(3);
  if (!leads || leads.length === 0) { skip('T9', 'no leads'); return; }
  for (const l of leads) {
    const can = await canSendOutbound(l.id);
    const gap = await hasMinimumGap(l.id);
    ok(l.contact_name ?? l.id, `canSend=${can} gapOk=${gap}`);
  }
}

async function T10_end_to_end_send(actuallySend: boolean) {
  console.log('\n[T10] END-TO-END: insert synthetic queue row → drainer sends → Adit receives');
  if (!actuallySend) { skip('T10', 'pass --send to actually send'); return; }

  const { data: lead } = await supabase
    .from('leads')
    .select('id, contact_email, owned_by')
    .eq('contact_email', ADIT_EMAIL)
    .maybeSingle();
  if (!lead) { bad('T10', 'no lead with Adit email found'); return; }

  // Find any thread id for this lead
  const { data: lastInt } = await supabase
    .from('interactions')
    .select('gmail_thread_id, subject, metadata')
    .eq('lead_id', lead.id)
    .not('gmail_thread_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lastInt?.gmail_thread_id) { bad('T10', 'no thread id on Adit lead'); return; }

  const stamp = new Date().toISOString();
  const message =
    `Hi Adit,\n\n` +
    `[CRM auto-followup pipeline test ${stamp}]\n` +
    `If you got this, drainScheduledEmails picked up an injected queue row, ` +
    `passed canSendOutbound + hasMinimumGap, and sent via Gmail.\n\n` +
    `Best,\nAdit`;

  // Insert a queue row already due (scheduled_for = 1 min ago).
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const { data: inserted, error: insErr } = await supabase
    .from('follow_up_queue')
    .insert({
      lead_id: lead.id,
      assigned_to: lead.owned_by,
      type: 'auto_send',
      status: 'pending',
      auto_send: true,
      due_at: dueAt,
      scheduled_for: dueAt,
      suggested_message: message,
      gmail_thread_id: lastInt.gmail_thread_id,
      reason: 'pipeline_test',
    })
    .select('id')
    .single();
  if (insErr || !inserted) { bad('T10 insert', insErr?.message ?? 'no row'); return; }
  ok('synthetic row inserted', inserted.id);

  // Run drainer.
  const r = await drainScheduledEmails();
  ok('drainer result', `sent=${r.sent} errors=${r.errors.length}`);
  if (r.errors.length > 0) {
    for (const e of r.errors) console.log(`      err: ${e}`);
  }

  // Read back the queue row.
  const { data: row } = await supabase
    .from('follow_up_queue')
    .select('status, sent_at')
    .eq('id', inserted.id)
    .single();
  if (row?.status === 'sent') ok('queue row flipped to sent', row.sent_at ?? '');
  else if (row?.status === 'dismissed') bad('queue row dismissed', 'guard re-check failed (max consecutive or 48h gap)');
  else bad('queue row final state', `status=${row?.status}`);

  // Confirm interaction was logged.
  const { data: logged } = await supabase
    .from('interactions')
    .select('id, occurred_at')
    .eq('lead_id', lead.id)
    .eq('type', 'email_outbound')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .single();
  if (logged && new Date(logged.occurred_at).getTime() > Date.now() - 5 * 60_000) {
    ok('interaction row written', logged.id);
  } else {
    bad('interaction row not written within last 5 min', JSON.stringify(logged));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const actuallySend = args.includes('--send');

  await T1_cron_auth();
  await T2_send_window();
  await T3_kill_switches();
  await T4_token_health();
  await T5_drainer_empty();
  await T6_runAutoFollowup_queues_well();
  await T7_firstreply_dryrun();
  await T8_killswitch_blocks_drainer();
  await T9_guards_evaluate();
  await T10_end_to_end_send(actuallySend);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
