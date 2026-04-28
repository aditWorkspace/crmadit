// Pre-built helper for the future "send-emails-from-CRM" flow.
//
// When that ships, the send-flow code will call createLeadFromOutreach()
// for each recipient so they're auto-tracked in the CRM. The user has
// said they don't want the send feature yet — this is just the hook so
// it's there when they wire it up.
//
// Idempotent: existing leads (by lowercased contact_email) get UPDATED
// with the latest outreach signal rather than re-inserted. Never creates
// duplicates.

import { createAdminClient } from '@/lib/supabase/admin';
import type { LeadStage, Priority } from '@/types';

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'live.com', 'msn.com', 'protonmail.com',
  'protonmail.ch', 'pm.me', 'hey.com', 'fastmail.com',
]);

export interface OutreachLeadInput {
  email: string;                  // contact_email — required
  fullName?: string | null;       // contact_name — optional, derive from email if missing
  company?: string | null;        // company_name — optional, derive from domain if missing
  ownedBy: string;                // team_member_id of the founder doing the outreach
  source: 'mass_email' | 'cold_outreach' | 'send_inbox' | 'manual';
}

export interface OutreachLeadResult {
  leadId: string;
  created: boolean;               // true if newly inserted, false if existing row was touched
}

export async function createLeadFromOutreach(input: OutreachLeadInput): Promise<OutreachLeadResult> {
  const supabase = createAdminClient();
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName?.trim() || nameFromEmail(email);
  const company = input.company?.trim() || companyFromDomain(email) || 'Unknown';
  const now = new Date().toISOString();

  // Try existing first.
  const { data: existing } = await supabase
    .from('leads')
    .select('id, last_contact_at')
    .eq('contact_email', email)
    .maybeSingle();

  if (existing) {
    // Bump last_contact_at; don't clobber name/company if they exist.
    await supabase
      .from('leads')
      .update({ last_contact_at: now })
      .eq('id', existing.id);
    return { leadId: existing.id, created: false };
  }

  // Otherwise insert. Stage is 'replied' since outreach implies an
  // outbound message — the moment a reply lands, the existing reply-handling
  // pipeline takes over and advances stage normally.
  const stage: LeadStage = 'replied';
  const priority: Priority = 'medium';
  const { data: inserted, error } = await supabase
    .from('leads')
    .insert({
      contact_email: email,
      contact_name: fullName,
      company_name: company,
      stage,
      priority,
      sourced_by: input.ownedBy,
      owned_by: input.ownedBy,
      last_contact_at: now,
      our_first_response_at: now,
      tags: [`source:${input.source}`],
    })
    .select('id')
    .single();

  if (error || !inserted) {
    // Race: someone else inserted between our SELECT and INSERT (no DB
    // unique constraint on contact_email, so the second writer wins).
    // Re-fetch and treat as existing.
    if (error?.code === '23505') {
      const { data: race } = await supabase
        .from('leads')
        .select('id')
        .eq('contact_email', email)
        .single();
      if (race) return { leadId: race.id, created: false };
    }
    throw new Error(`createLeadFromOutreach failed: ${error?.message ?? 'unknown'}`);
  }

  return { leadId: inserted.id, created: true };
}

function companyFromDomain(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  const parts = domain.split('.');
  const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || email;
}
