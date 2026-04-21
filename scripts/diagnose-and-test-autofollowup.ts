/**
 * Diagnostic + live send test for the auto-followup pipeline.
 *
 * 1. Prints the runtime state every gate cares about: kill-switch env vars,
 *    sending-window check, each founder's gmail_connected flag.
 * 2. Lists any leads whose `contact_email` matches a founder address — these
 *    are the rows that auto-followup would actually act on.
 * 3. For every founder→founder pair, sends a real test email via the same
 *    `sendBccEmail` plumbing the auto-paths use. Reports the Gmail message
 *    id (success) or the raw API error (failure).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/diagnose-and-test-autofollowup.ts --diagnose
 *   npx tsx --env-file=.env.local scripts/diagnose-and-test-autofollowup.ts --send
 *   npx tsx --env-file=.env.local scripts/diagnose-and-test-autofollowup.ts --diagnose --send
 */

import { createClient } from '@supabase/supabase-js';
import { getGmailClientForMember } from '../src/lib/gmail/client';
import { sendBccEmail } from '../src/lib/gmail/send';
import {
  isWithinSendingWindow,
} from '../src/lib/automation/send-guards';
import {
  autoReplyEnabled,
  fastLoopEnabled,
  infoReplyEnabled,
} from '../src/lib/automation/kill-switch';
import { runAutoFollowup } from '../src/lib/automation/auto-followup';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// The actual addresses in team_members (NOT @proxi.ai as one might assume).
const FOUNDER_EMAILS = [
  'aditmittal@berkeley.edu',
  'asim_ali@berkeley.edu',
  'srijay_vejendla@berkeley.edu',
];

async function diagnose() {
  console.log('\n=== ENV / KILL SWITCHES ===');
  console.log(`AUTO_REPLY_ENABLED env: ${process.env.AUTO_REPLY_ENABLED ?? '(unset → enabled)'}`);
  console.log(`FAST_LOOP_ENABLED  env: ${process.env.FAST_LOOP_ENABLED ?? '(unset → enabled)'}`);
  console.log(`INFO_REPLY_ENABLED env: ${process.env.INFO_REPLY_ENABLED ?? '(unset → enabled)'}`);
  console.log(`autoReplyEnabled():  ${autoReplyEnabled()}`);
  console.log(`fastLoopEnabled():   ${fastLoopEnabled()}`);
  console.log(`infoReplyEnabled():  ${infoReplyEnabled()}`);

  const now = new Date();
  console.log(`\nNow: ${now.toISOString()} (PT: ${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })})`);
  console.log(`isWithinSendingWindow(): ${isWithinSendingWindow(now)}  ← if false, first-reply responder + drainer SKIP send`);

  console.log('\n=== TEAM MEMBERS ===');
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected, gmail_token_expiry, last_gmail_sync')
    .order('name');
  for (const m of members ?? []) {
    console.log(`  ${m.name.padEnd(8)}  ${m.email.padEnd(28)}  gmail_connected=${m.gmail_connected}  expiry=${m.gmail_token_expiry ?? 'none'}  last_sync=${m.last_gmail_sync ?? 'never'}`);
  }

  console.log('\n=== LEADS WITH FOUNDER EMAILS ===');
  const { data: founderLeads } = await supabase
    .from('leads')
    .select('id, contact_name, contact_email, owned_by, stage, is_archived, last_contact_at, auto_replied_to_first')
    .in('contact_email', FOUNDER_EMAILS);

  if (!founderLeads || founderLeads.length === 0) {
    console.log('  (no leads with contact_email in founder list)');
    console.log('  → auto-followup CAN NEVER fire for founder addresses unless a lead exists with that contact_email.');
  } else {
    for (const l of founderLeads) {
      console.log(`  ${l.contact_email.padEnd(28)}  stage=${l.stage}  archived=${l.is_archived}  auto_replied=${l.auto_replied_to_first}  owned_by=${l.owned_by ?? 'NONE'}  last_contact=${l.last_contact_at ?? 'never'}`);
    }
  }

  console.log('\n=== PENDING auto_send QUEUE ROWS ===');
  const { data: queue } = await supabase
    .from('follow_up_queue')
    .select('id, lead_id, type, status, scheduled_for, created_at')
    .eq('auto_send', true)
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true })
    .limit(20);
  if (!queue || queue.length === 0) {
    console.log('  (no pending auto_send queue rows)');
  } else {
    for (const q of queue) {
      console.log(`  ${q.id}  lead=${q.lead_id}  type=${q.type}  scheduled_for=${q.scheduled_for}`);
    }
  }
}

async function sendTestEmails() {
  console.log('\n=== LIVE SEND TEST: founder → founder ===');
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected')
    .in('email', FOUNDER_EMAILS);

  if (!members || members.length === 0) {
    console.log('  no founders found in DB, abort.');
    return;
  }

  const stamp = new Date().toISOString();
  for (const sender of members) {
    if (!sender.gmail_connected) {
      console.log(`  [${sender.name}] SKIP: gmail_connected=false`);
      continue;
    }
    const recipients = members
      .filter(m => m.id !== sender.id)
      .map(m => m.email);
    if (recipients.length === 0) continue;

    for (const to of recipients) {
      const subject = `[CRM autofollowup test] ${sender.name} → ${to} ${stamp}`;
      const body =
        `This is a live test of the auto-followup Gmail plumbing.\n\n` +
        `Sender: ${sender.name} <${sender.email}>\n` +
        `Path:   sendBccEmail (same as drainScheduledEmails uses for new threads)\n` +
        `Time:   ${stamp}\n\n` +
        `If you got this, the OAuth tokens + Gmail send for ${sender.name} work.\n`;

      try {
        const id = await sendBccEmail({
          teamMemberId: sender.id,
          bccRecipients: [to],
          subject,
          body,
        });
        console.log(`  ✓ ${sender.name.padEnd(8)} → ${to.padEnd(28)}  gmail_id=${id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ ${sender.name.padEnd(8)} → ${to.padEnd(28)}  ERROR: ${msg}`);
      }
    }
  }

  // Also confirm each founder's token can mint a Gmail client at all.
  console.log('\n=== TOKEN HEALTH (getGmailClientForMember) ===');
  for (const m of members) {
    if (!m.gmail_connected) {
      console.log(`  ${m.name.padEnd(8)} not connected`);
      continue;
    }
    try {
      const { gmail } = await getGmailClientForMember(m.id);
      const profile = await gmail.users.getProfile({ userId: 'me' });
      console.log(`  ${m.name.padEnd(8)} OK  effective sender = ${profile.data.emailAddress}`);
    } catch (err) {
      console.log(`  ${m.name.padEnd(8)} ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function queueRun() {
  console.log('\n=== runAutoFollowup() — queues only, drainer sends later ===');
  const before = await supabase
    .from('follow_up_queue')
    .select('id', { count: 'exact', head: true })
    .eq('auto_send', true)
    .eq('status', 'pending')
    .not('scheduled_for', 'is', null);
  console.log(`  queue (auto_send, pending, scheduled_for NOT NULL) before: ${before.count}`);

  const r = await runAutoFollowup();
  console.log(`  result: processed=${r.processed} queued=${r.queued} skipped=${r.skipped}`);
  console.log(`  skipped_reasons:`, r.skipped_reasons);
  if (r.errors.length) console.log(`  errors:`, r.errors);

  const after = await supabase
    .from('follow_up_queue')
    .select('id, lead_id, scheduled_for, suggested_message')
    .eq('auto_send', true)
    .eq('status', 'pending')
    .not('scheduled_for', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`  queue (auto_send, pending, scheduled_for NOT NULL) after: ${after.data?.length ?? 0} (sample, capped 10)`);
  for (const row of after.data ?? []) {
    const preview = (row.suggested_message ?? '').replace(/\n/g, ' ').slice(0, 80);
    console.log(`    ${row.id}  lead=${row.lead_id}  scheduled=${row.scheduled_for}`);
    console.log(`      msg: ${preview}…`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doDiagnose = args.includes('--diagnose') || args.length === 0;
  const doSend = args.includes('--send');
  const doQueue = args.includes('--queue');

  if (doDiagnose) await diagnose();
  if (doSend) await sendTestEmails();
  if (doQueue) await queueRun();
  if (!doDiagnose && !doSend && !doQueue) {
    console.log('Pass --diagnose, --send, --queue, or any combination.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
