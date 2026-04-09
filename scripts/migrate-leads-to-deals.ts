/**
 * Backfill script: migrate data from monolithic `leads` table into
 * companies, contacts, and deals.
 *
 * Idempotent — safe to run multiple times. Uses existing records if found.
 *
 * Usage: npx tsx scripts/migrate-leads-to-deals.ts
 *
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function extractDomain(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  // Skip common email providers — these don't represent a company domain
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'protonmail.com'];
  return generic.includes(domain) ? null : domain;
}

async function main() {
  console.log('Starting leads → companies/contacts/deals migration...\n');

  // Fetch all leads
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: true });

  if (leadsErr) { console.error('Failed to fetch leads:', leadsErr); process.exit(1); }
  console.log(`Found ${leads.length} leads to migrate.\n`);

  let companiesCreated = 0, companiesReused = 0;
  let contactsCreated = 0, contactsReused = 0;
  let dealsCreated = 0, dealsSkipped = 0;

  for (const lead of leads) {
    // Check if already migrated
    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('legacy_lead_id', lead.id)
      .maybeSingle();

    if (existingDeal) {
      dealsSkipped++;
      continue;
    }

    // ── Find or create company ──────────────────────────────────────────────
    const domain = extractDomain(lead.contact_email);
    let companyId: string | null = null;

    if (domain) {
      // Try by domain first
      const { data: existingCo } = await supabase
        .from('companies')
        .select('id')
        .eq('domain', domain)
        .maybeSingle();

      if (existingCo) {
        companyId = existingCo.id;
        companiesReused++;
      }
    }

    if (!companyId) {
      // Try by exact name match
      const { data: byName } = await supabase
        .from('companies')
        .select('id')
        .eq('name', lead.company_name)
        .maybeSingle();

      if (byName) {
        companyId = byName.id;
        companiesReused++;
      }
    }

    if (!companyId) {
      // Create new company
      const { data: newCo, error: coErr } = await supabase
        .from('companies')
        .insert({
          name: lead.company_name,
          domain,
          url: lead.company_url,
          stage: lead.company_stage,
          size: lead.company_size,
        })
        .select('id')
        .single();

      if (coErr) { console.error(`  Company creation failed for ${lead.company_name}:`, coErr.message); continue; }
      companyId = newCo.id;
      companiesCreated++;
    }

    // ── Find or create contact ──────────────────────────────────────────────
    let contactId: string;

    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .eq('email', lead.contact_email)
      .maybeSingle();

    if (existingContact) {
      contactId = existingContact.id;
      contactsReused++;
    } else {
      const { data: newContact, error: cErr } = await supabase
        .from('contacts')
        .insert({
          company_id: companyId,
          name: lead.contact_name,
          email: lead.contact_email,
          role: lead.contact_role,
          linkedin: lead.contact_linkedin,
          tags: lead.tags,
        })
        .select('id')
        .single();

      if (cErr) { console.error(`  Contact creation failed for ${lead.contact_email}:`, cErr.message); continue; }
      contactId = newContact.id;
      contactsCreated++;
    }

    // ── Create deal ─────────────────────────────────────────────────────────
    const { data: newDeal, error: dErr } = await supabase
      .from('deals')
      .insert({
        contact_id: contactId,
        company_id: companyId,
        sourced_by: lead.sourced_by,
        owned_by: lead.owned_by,
        call_participants: lead.call_participants,
        stage: lead.stage,
        priority: lead.priority,
        first_reply_at: lead.first_reply_at,
        our_first_response_at: lead.our_first_response_at,
        call_scheduled_for: lead.call_scheduled_for,
        call_completed_at: lead.call_completed_at,
        demo_sent_at: lead.demo_sent_at,
        product_access_granted_at: lead.product_access_granted_at,
        last_contact_at: lead.last_contact_at,
        next_followup_at: lead.next_followup_at,
        time_to_our_response_hrs: lead.time_to_our_response_hrs,
        time_to_schedule_hrs: lead.time_to_schedule_hrs,
        time_to_call_hrs: lead.time_to_call_hrs,
        time_to_send_demo_hrs: lead.time_to_send_demo_hrs,
        our_avg_reply_speed_hrs: lead.our_avg_reply_speed_hrs,
        call_summary: lead.call_summary,
        call_notes: lead.call_notes,
        next_steps: lead.next_steps,
        tags: lead.tags,
        poc_status: lead.poc_status,
        poc_notes: lead.poc_notes,
        heat_score: lead.heat_score,
        ai_heat_reason: lead.ai_heat_reason,
        ai_next_action: lead.ai_next_action,
        ai_next_action_at: lead.ai_next_action_at,
        paused_until: lead.paused_until,
        paused_previous_stage: lead.paused_previous_stage,
        pinned_note: lead.pinned_note,
        is_archived: lead.is_archived,
        legacy_lead_id: lead.id,
        created_at: lead.created_at,
        updated_at: lead.updated_at,
      })
      .select('id')
      .single();

    if (dErr) { console.error(`  Deal creation failed for ${lead.contact_name}:`, dErr.message); continue; }
    dealsCreated++;

    // ── Link related records to new deal ────────────────────────────────────
    const dealId = newDeal.id;
    const tables = ['interactions', 'action_items', 'follow_up_queue', 'activity_log', 'transcripts'];
    for (const table of tables) {
      await supabase
        .from(table)
        .update({ deal_id: dealId })
        .eq('lead_id', lead.id)
        .is('deal_id', null);
    }

    console.log(`  ✓ ${lead.contact_name} (${lead.company_name}) → deal ${dealId}`);
  }

  console.log('\n── Migration Summary ──');
  console.log(`Companies: ${companiesCreated} created, ${companiesReused} reused`);
  console.log(`Contacts:  ${contactsCreated} created, ${contactsReused} reused`);
  console.log(`Deals:     ${dealsCreated} created, ${dealsSkipped} skipped (already migrated)`);
  console.log('\nDone.');
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
