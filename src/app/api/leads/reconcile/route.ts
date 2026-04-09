import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const CALL_KEYWORDS = [
  'call', 'spoke with', 'discussed on the phone', 'per our conversation',
  'meeting', 'demo', 'zoom', 'google meet', 'let\'s hop on', 'quick chat',
  'scheduled a call', 'booked a meeting', 'calendar invite',
  'talked about', 'on the call', 'during our call',
];

/**
 * POST /api/leads/reconcile
 *
 * Scans all email interactions from the last 30 days. If an email mentions
 * a call but the lead has no call_completed_at or call_scheduled_for,
 * flags it as a discrepancy.
 *
 * Returns flagged leads so the user can review and fix.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get all email interactions from last 30 days
  const { data: interactions, error: intErr } = await supabase
    .from('interactions')
    .select('id, lead_id, type, subject, body, occurred_at, team_member_id')
    .in('type', ['email_inbound', 'email_outbound'])
    .gte('occurred_at', thirtyDaysAgo)
    .order('occurred_at', { ascending: false });

  if (intErr) return NextResponse.json({ error: intErr.message }, { status: 500 });

  // Find interactions that mention calls
  const callMentions = new Map<string, { interaction_id: string; snippet: string; occurred_at: string }[]>();

  for (const i of interactions || []) {
    const text = `${i.subject || ''} ${i.body || ''}`.toLowerCase();
    const matchedKeyword = CALL_KEYWORDS.find(kw => text.includes(kw));
    if (!matchedKeyword) continue;

    const existing = callMentions.get(i.lead_id) || [];
    // Get surrounding context
    const idx = text.indexOf(matchedKeyword);
    const snippet = text.slice(Math.max(0, idx - 30), idx + matchedKeyword.length + 30).trim();
    existing.push({ interaction_id: i.id, snippet, occurred_at: i.occurred_at });
    callMentions.set(i.lead_id, existing);
  }

  if (callMentions.size === 0) {
    return NextResponse.json({
      success: true,
      emails_scanned: interactions?.length || 0,
      discrepancies: [],
      summary: { total_scanned: interactions?.length || 0, calls_logged: 0, discrepancies_found: 0 },
    });
  }

  // Get the leads that have call mentions
  const leadIds = [...callMentions.keys()];
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, call_scheduled_for, call_completed_at, owned_by')
    .in('id', leadIds)
    .eq('is_archived', false);

  // Fetch team member names
  const { data: members } = await supabase.from('team_members').select('id, name');
  const nameOf = (id: string) => members?.find(m => m.id === id)?.name || id;

  // Count leads that already have call data logged
  let callsLogged = 0;

  // Find discrepancies: email mentions call but lead has no call timestamps
  const discrepancies: Array<{
    lead_id: string;
    contact_name: string;
    company_name: string;
    owner: string;
    stage: string;
    has_call_scheduled: boolean;
    has_call_completed: boolean;
    mentions: Array<{ snippet: string; date: string }>;
  }> = [];

  for (const lead of leads || []) {
    const mentions = callMentions.get(lead.id) || [];
    const hasCallData = !!lead.call_scheduled_for || !!lead.call_completed_at;

    if (hasCallData) {
      callsLogged++;
      continue;
    }

    // This lead has call references in emails but no call data
    discrepancies.push({
      lead_id: lead.id,
      contact_name: lead.contact_name,
      company_name: lead.company_name,
      owner: nameOf(lead.owned_by),
      stage: lead.stage,
      has_call_scheduled: !!lead.call_scheduled_for,
      has_call_completed: !!lead.call_completed_at,
      mentions: mentions.slice(0, 3).map(m => ({ snippet: m.snippet, date: m.occurred_at })),
    });
  }

  return NextResponse.json({
    success: true,
    emails_scanned: interactions?.length || 0,
    discrepancies,
    summary: {
      total_scanned: interactions?.length || 0,
      leads_with_call_mentions: callMentions.size,
      calls_logged: callsLogged,
      discrepancies_found: discrepancies.length,
    },
  });
}
