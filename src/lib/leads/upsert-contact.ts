// Idempotent upsert of an external participant onto a lead.
//
// Called from Gmail sync after we've matched a thread to a lead — for each
// non-founder, non-role-based address on the From/To/Cc headers, ensure
// there's a row in `lead_contacts` for that lead. The unique index on
// (lead_id, lower(email)) makes this safe to call repeatedly: first call
// inserts, later calls update name only if we now have a better one.

import type { createAdminClient } from '@/lib/supabase/admin';
import { isLikelyHumanEmail, nameFromEmail, parseAddressList, type AddressEntry } from './contact-utils';

type Supa = ReturnType<typeof createAdminClient>;

export type ContactSource = 'primary' | 'cc' | 'reply' | 'matcher' | 'calendar' | 'manual';

export async function upsertLeadContact(
  supabase: Supa,
  args: {
    leadId: string;
    email: string;
    name?: string | null;
    source: ContactSource;
  }
): Promise<void> {
  const email = args.email.trim().toLowerCase();
  if (!isLikelyHumanEmail(email)) return;

  const name = args.name?.trim() || nameFromEmail(email);

  // Try to fetch existing row first so we can avoid clobbering a real
  // human-curated name with an auto-derived one.
  const { data: existing } = await supabase
    .from('lead_contacts')
    .select('id, name')
    .eq('lead_id', args.leadId)
    .ilike('email', email)
    .maybeSingle();

  if (existing) {
    // Only update if existing name is empty/null and we have something better.
    const existingName = (existing as { name: string | null }).name;
    if (!existingName && name) {
      await supabase
        .from('lead_contacts')
        .update({ name })
        .eq('id', (existing as { id: string }).id);
    }
    return;
  }

  const { error } = await supabase.from('lead_contacts').insert({
    lead_id: args.leadId,
    email,
    name,
    is_primary: false,
    source: args.source,
  });
  // 23505 = race with concurrent insert — fine, the other writer won.
  if (error && (error as { code?: string }).code !== '23505') {
    console.error('[upsertLeadContact] insert failed:', error.message);
  }
}

// Collect every external participant from a parsed email's headers.
// Excludes founders (anyone in `teamEmails`) and the syncing member.
export function collectExternalParticipants(
  fromHeader: string,
  toHeader: string,
  ccHeader: string,
  teamEmails: Set<string>
): AddressEntry[] {
  const all: AddressEntry[] = [
    ...parseAddressList(fromHeader),
    ...parseAddressList(toHeader),
    ...parseAddressList(ccHeader),
  ];
  const seen = new Set<string>();
  const out: AddressEntry[] = [];
  for (const entry of all) {
    const e = entry.email.toLowerCase();
    if (seen.has(e)) continue;
    if (teamEmails.has(e)) continue;
    if (!isLikelyHumanEmail(e)) continue;
    seen.add(e);
    out.push({ ...entry, email: e });
  }
  return out;
}
