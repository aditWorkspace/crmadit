/**
 * One-time script to clean up uninterested leads from the CRM.
 *
 * Run: node scripts/cleanup-uninterested.mjs [--dry-run]
 *
 * Uses keyword matching for obvious cases, AI for ambiguous ones.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env vars from .env.local
const envPath = resolve(import.meta.dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_KEY = env.OPENROUTER_API_KEY;
// Use paid model for batch processing (no rate limits, ~$0.01 total for 100 leads)
const MODEL = 'google/gemma-4-26b-a4b-it';
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Keyword-based fast classifier ──────────────────────────────────────────
// These patterns catch the obvious "not interested" replies without needing AI.
const NOT_INTERESTED_PATTERNS = [
  /wrong company/i,
  /wrong person/i,
  /wrong email/i,
  /not interested/i,
  /no thanks/i,
  /no thank you/i,
  /please stop/i,
  /stop email/i,
  /stop contact/i,
  /unsubscribe/i,
  /remove me/i,
  /take me off/i,
  /don'?t email/i,
  /don'?t contact/i,
  /do not email/i,
  /do not contact/i,
  /spam/i,
  /mass email/i,
  /mass-email/i,
  /AI (email|tool|generated|spam)/i,
  /using AI/i,
  /pretty lazy/i,
  /nice try/i,
  /get lost/i,
  /leave me alone/i,
  /not the right (person|contact|company)/i,
  /we('re| are) not/i,
  /we don'?t (need|want|use)/i,
  /i don'?t (need|want)/i,
  /not relevant/i,
  /not applicable/i,
  /doesn'?t apply/i,
  /not a fit/i,
  /not a good fit/i,
  /no need/i,
  /pass on this/i,
  /not at this time/i,
  /we'?ll pass/i,
  /i'?ll pass/i,
];

function classifyByKeywords(body) {
  const stripped = body
    .replace(/^>.*$/gm, '')      // Remove quoted reply lines
    .replace(/On .+ wrote:[\s\S]*$/m, '') // Remove "On ... wrote:" and everything after
    .trim();

  if (!stripped) return 'unknown'; // Only quoted text, no actual reply

  for (const pattern of NOT_INTERESTED_PATTERNS) {
    if (pattern.test(stripped)) return 'not_interested';
  }
  return 'unknown'; // Ambiguous — would need AI
}

// ── AI classifier for ambiguous cases ──────────────────────────────────────
async function classifyByAI(subject, body) {
  const maxRetries = 4;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: `You classify email replies to cold outreach. Respond with ONLY a JSON object.

The outreach is from a Berkeley student startup about product prioritization software.

Reply "not_interested" if the prospect: says they aren't interested, wrong company/person, complains about AI/mass email, wants to stop receiving emails, or gives a dismissive/hostile response.

Reply "interested" if they: ask questions, want to schedule, share availability, ask for info, give positive/neutral response, or redirect to someone else. When in doubt, say interested.

Respond with ONLY: {"intent": "interested"} or {"intent": "not_interested"}`
            },
            { role: 'user', content: `Subject: ${subject}\n\nReply:\n${body.slice(0, 600)}` }
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status}`);

      const data = await res.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      return parsed.intent === 'not_interested' ? 'not_interested' : 'interested';
    } catch {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      return 'interested'; // Default safe
    }
  }
  return 'interested';
}

async function main() {
  console.log(`\n${DRY_RUN ? '🔍 DRY RUN' : '🗑️  LIVE CLEANUP'} — Scanning replied-stage leads...\n`);

  // First check if any leads were already partially cleaned by the earlier run
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_name, company_name')
    .eq('is_archived', false)
    .eq('stage', 'replied')
    .order('created_at', { ascending: false });

  if (error) { console.error('Failed to fetch leads:', error.message); process.exit(1); }
  console.log(`Found ${leads.length} leads in "replied" stage\n`);

  const archived = [];
  const kept = [];
  const ambiguous = [];

  // Phase 1: Fast keyword classification (no AI, instant)
  console.log('═══ Phase 1: Keyword Classification (instant) ═══\n');

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];

    const { data: emails } = await supabase
      .from('interactions')
      .select('subject, body')
      .eq('lead_id', lead.id)
      .eq('type', 'email_inbound')
      .order('occurred_at', { ascending: true })
      .limit(1);

    if (!emails?.length) {
      kept.push(lead);
      continue;
    }

    const email = emails[0];
    const result = classifyByKeywords(email.body || '');

    if (result === 'not_interested') {
      console.log(`  ❌ ${lead.contact_name} @ ${lead.company_name}`);
      console.log(`     "${(email.body || '').replace(/\n/g, ' ').slice(0, 80)}..."`);
      archived.push({ ...lead, snippet: (email.body || '').slice(0, 80) });

      if (!DRY_RUN) {
        await supabase
          .from('leads')
          .update({ stage: 'dead', is_archived: true, updated_at: new Date().toISOString() })
          .eq('id', lead.id);
        await supabase
          .from('follow_up_queue')
          .update({ status: 'dismissed', updated_at: new Date().toISOString() })
          .eq('lead_id', lead.id)
          .eq('status', 'pending');
      }
    } else {
      ambiguous.push({ lead, email });
    }
  }

  console.log(`\nPhase 1 done: ${archived.length} archived, ${ambiguous.length} need AI review\n`);

  // Phase 2: AI classification for ambiguous cases (slower, rate-limited)
  if (ambiguous.length > 0 && OPENROUTER_KEY) {
    console.log('═══ Phase 2: AI Classification (slower) ═══\n');

    for (let i = 0; i < ambiguous.length; i++) {
      const { lead, email } = ambiguous[i];
      process.stdout.write(`  [${i + 1}/${ambiguous.length}] ${lead.contact_name} @ ${lead.company_name}... `);

      const intent = await classifyByAI(email.subject || '', email.body || '');

      if (intent === 'not_interested') {
        console.log('❌ NOT INTERESTED');
        archived.push({ ...lead, snippet: (email.body || '').replace(/\n/g, ' ').slice(0, 80) });

        if (!DRY_RUN) {
          await supabase
            .from('leads')
            .update({ stage: 'dead', is_archived: true, updated_at: new Date().toISOString() })
            .eq('id', lead.id);
          await supabase
            .from('follow_up_queue')
            .update({ status: 'dismissed', updated_at: new Date().toISOString() })
            .eq('lead_id', lead.id)
            .eq('status', 'pending');
        }
      } else {
        console.log('✅ kept');
        kept.push(lead);
      }

      // Small spacing between calls
      await new Promise(r => setTimeout(r, 500));
    }
  } else if (ambiguous.length > 0) {
    // No API key, just keep the ambiguous ones
    for (const { lead } of ambiguous) kept.push(lead);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULTS ${DRY_RUN ? '(DRY RUN — no changes made)' : '(LIVE — changes applied)'}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`Leads checked:  ${leads.length}`);
  console.log(`Archived:       ${archived.length}`);
  console.log(`Kept:           ${kept.length}`);

  if (archived.length > 0) {
    console.log(`\nArchived leads:`);
    for (const a of archived) {
      console.log(`  • ${a.contact_name} @ ${a.company_name}`);
    }
  }

  console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
