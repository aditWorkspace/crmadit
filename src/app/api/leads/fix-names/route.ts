import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeName } from '@/lib/name-utils';

/**
 * POST /api/leads/fix-names
 *
 * Normalizes all lead contact_name fields to proper title case.
 * Also fixes company names that are clearly wrong (e.g., all-lowercase).
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_name, company_name')
    .eq('is_archived', false);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const changes: Array<{ id: string; field: string; from: string; to: string }> = [];

  for (const lead of leads || []) {
    const updates: Record<string, string> = {};

    // Fix contact name
    const normalizedName = normalizeName(lead.contact_name);
    if (normalizedName !== lead.contact_name) {
      updates.contact_name = normalizedName;
      changes.push({ id: lead.id, field: 'contact_name', from: lead.contact_name, to: normalizedName });
    }

    // Fix company name — title case if it looks wrong
    if (lead.company_name) {
      const co = lead.company_name;
      // Only fix if all-lowercase or all-uppercase (preserve intentional casing otherwise)
      if (co === co.toLowerCase() && co.length > 3) {
        const fixed = normalizeName(co, true);
        if (fixed !== co) {
          updates.company_name = fixed;
          changes.push({ id: lead.id, field: 'company_name', from: co, to: fixed });
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from('leads').update(updates).eq('id', lead.id);
    }
  }

  return NextResponse.json({
    success: true,
    leads_checked: leads?.length || 0,
    names_fixed: changes.length,
    changes: changes.slice(0, 50), // cap output
  });
}
