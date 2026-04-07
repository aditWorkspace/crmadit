import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/leads/dedup
 *
 * Finds duplicate leads by BOTH:
 *   - Same contact_email
 *   - Same contact first name (case-insensitive) — catches "Lynette/Disgo" vs "Lynette/Disgoapp"
 *
 * The "true owner" is the founder with the most outbound emails on the lead.
 *
 * For each duplicate group:
 *  1. Pick the lead with the most outbound emails as the primary
 *  2. Re-assign all interactions from duplicates → primary lead
 *  3. Re-assign all action_items from duplicates → primary lead
 *  4. Archive the duplicate leads
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Fetch owner names once
  const { data: members } = await supabase.from('team_members').select('id, name');
  const nameOf = (id: string) => members?.find(m => m.id === id)?.name || id;

  // 1. Find all active leads
  const { data: allLeads, error: fetchErr } = await supabase
    .from('leads')
    .select('id, contact_name, contact_email, company_name, owned_by, stage, created_at, updated_at')
    .eq('is_archived', false)
    .not('stage', 'eq', 'dead')
    .order('created_at', { ascending: true });

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!allLeads) return NextResponse.json({ success: true, duplicates_found: 0, leads_archived: 0, details: [] });

  // 2. Build duplicate groups — a lead belongs to the group of its earliest match
  //    Match by: (a) same contact_email, OR (b) same first name with similar-enough data
  const leadGroups = new Map<string, typeof allLeads>(); // groupKey → leads
  const leadToGroup = new Map<string, string>();          // leadId → groupKey

  for (const lead of allLeads) {
    const email = (lead.contact_email || '').toLowerCase().trim();
    const firstName = (lead.contact_name || '').split(/\s+/)[0].toLowerCase().trim();

    // Try to find an existing group this lead matches
    let matchedGroup: string | null = null;

    // Check by email first (strongest signal)
    if (email) {
      for (const [groupKey, group] of leadGroups) {
        if (group.some(l => (l.contact_email || '').toLowerCase().trim() === email)) {
          matchedGroup = groupKey;
          break;
        }
      }
    }

    // If no email match, check by first name + contact_email domain similarity
    if (!matchedGroup && firstName && email) {
      const emailDomain = email.split('@')[1] || '';
      for (const [groupKey, group] of leadGroups) {
        const match = group.some(l => {
          const lName = (l.contact_name || '').split(/\s+/)[0].toLowerCase().trim();
          const lEmail = (l.contact_email || '').toLowerCase().trim();
          const lDomain = lEmail.split('@')[1] || '';
          // Same first name AND same email domain = same person
          return lName === firstName && lDomain === emailDomain && firstName.length >= 3;
        });
        if (match) {
          matchedGroup = groupKey;
          break;
        }
      }
    }

    if (matchedGroup) {
      leadGroups.get(matchedGroup)!.push(lead);
      leadToGroup.set(lead.id, matchedGroup);
    } else {
      const key = email || `name:${firstName}:${lead.company_name}`;
      leadGroups.set(key, [lead]);
      leadToGroup.set(lead.id, key);
    }
  }

  // 3. Process each group with > 1 lead
  const mergeLog: Array<{
    email: string;
    primary: { id: string; name: string; company: string; owner: string };
    merged: Array<{ id: string; name: string; company: string; owner: string }>;
  }> = [];

  let totalMerged = 0;

  for (const [groupKey, group] of leadGroups) {
    if (group.length <= 1) continue;

    // Count outbound emails per lead to determine true owner
    const leadsWithCounts = await Promise.all(
      group.map(async (lead) => {
        const { count: outbound } = await supabase
          .from('interactions')
          .select('*', { count: 'exact', head: true })
          .eq('lead_id', lead.id)
          .eq('type', 'email_outbound');

        const { count: total } = await supabase
          .from('interactions')
          .select('*', { count: 'exact', head: true })
          .eq('lead_id', lead.id);

        return { lead, outboundCount: outbound || 0, totalCount: total || 0 };
      })
    );

    // Sort: most outbound first, then most total, then oldest
    leadsWithCounts.sort((a, b) => {
      if (b.outboundCount !== a.outboundCount) return b.outboundCount - a.outboundCount;
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      return new Date(a.lead.created_at).getTime() - new Date(b.lead.created_at).getTime();
    });

    const primary = leadsWithCounts[0].lead;
    const duplicates = leadsWithCounts.slice(1).map(x => x.lead);

    // Merge each duplicate into primary
    for (const dup of duplicates) {
      // Move interactions (skip duplicates by gmail_message_id)
      const { data: dupInteractions } = await supabase
        .from('interactions')
        .select('id, gmail_message_id')
        .eq('lead_id', dup.id);

      for (const interaction of dupInteractions || []) {
        if (interaction.gmail_message_id) {
          const { data: existing } = await supabase
            .from('interactions')
            .select('id')
            .eq('lead_id', primary.id)
            .eq('gmail_message_id', interaction.gmail_message_id)
            .limit(1)
            .maybeSingle();

          if (existing) {
            await supabase.from('interactions').delete().eq('id', interaction.id);
            continue;
          }
        }
        await supabase
          .from('interactions')
          .update({ lead_id: primary.id })
          .eq('id', interaction.id);
      }

      // Move action items
      await supabase
        .from('action_items')
        .update({ lead_id: primary.id })
        .eq('lead_id', dup.id);

      // Move activity log
      await supabase
        .from('activity_log')
        .update({ lead_id: primary.id })
        .eq('lead_id', dup.id);

      // Archive the duplicate
      await supabase
        .from('leads')
        .update({ is_archived: true, updated_at: new Date().toISOString() })
        .eq('id', dup.id);

      totalMerged++;
    }

    mergeLog.push({
      email: groupKey,
      primary: { id: primary.id, name: primary.contact_name, company: primary.company_name, owner: nameOf(primary.owned_by) },
      merged: duplicates.map(d => ({ id: d.id, name: d.contact_name, company: d.company_name, owner: nameOf(d.owned_by) })),
    });
  }

  return NextResponse.json({
    success: true,
    duplicates_found: mergeLog.length,
    leads_archived: totalMerged,
    details: mergeLog,
  });
}
