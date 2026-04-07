import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/leads/fix-ownership
 *
 * For EVERY active lead:
 *  1. Look at all interactions to find who sent the FIRST outbound email → that's the true owner
 *  2. If no outbound email, check who has the most outbound emails → owner
 *  3. Fix the owned_by + sourced_by fields
 *  4. Verify stage is correct based on interaction history:
 *     - Has call_completed_at or a "call completed" interaction → call_completed
 *     - Has call_scheduled_for in the future → scheduled
 *     - Has a scheduling-related email exchange → scheduling
 *     - Otherwise → replied (if there's an inbound reply)
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();

  // Fetch all team members
  const { data: members } = await supabase.from('team_members').select('id, name, email');
  const nameOf = (id: string) => members?.find(m => m.id === id)?.name || id;
  const memberByEmail = new Map<string, string>();
  for (const m of members || []) {
    memberByEmail.set(m.email.toLowerCase(), m.id);
  }

  // Fetch all active leads
  const { data: allLeads, error: fetchErr } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, contact_email, owned_by, sourced_by, stage, call_scheduled_for, call_completed_at, demo_sent_at')
    .eq('is_archived', false)
    .not('stage', 'eq', 'dead');

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!allLeads) return NextResponse.json({ success: true, changes: [] });

  const changes: Array<{
    lead: string;
    company: string;
    field: string;
    from: string;
    to: string;
  }> = [];

  for (const lead of allLeads) {
    // Get all interactions for this lead, ordered by time
    const { data: interactions } = await supabase
      .from('interactions')
      .select('id, type, team_member_id, subject, body, occurred_at, metadata, gmail_message_id')
      .eq('lead_id', lead.id)
      .order('occurred_at', { ascending: true });

    if (!interactions || interactions.length === 0) continue;

    // ── 1. Determine true owner from first outbound email ──────────────
    const outboundEmails = interactions.filter(i => i.type === 'email_outbound');
    const inboundEmails = interactions.filter(i => i.type === 'email_inbound');
    const firstOutbound = outboundEmails[0];

    let trueOwnerId: string | null = null;

    if (firstOutbound) {
      // The person who sent the first outreach email is the owner
      trueOwnerId = firstOutbound.team_member_id;
    } else if (outboundEmails.length > 0) {
      // Count outbound by member, pick the one with most
      const counts = new Map<string, number>();
      for (const e of outboundEmails) {
        counts.set(e.team_member_id, (counts.get(e.team_member_id) || 0) + 1);
      }
      let maxCount = 0;
      for (const [mid, count] of counts) {
        if (count > maxCount) { maxCount = count; trueOwnerId = mid; }
      }
    }

    // Update ownership if wrong
    if (trueOwnerId && trueOwnerId !== lead.owned_by) {
      changes.push({
        lead: lead.contact_name,
        company: lead.company_name,
        field: 'owned_by',
        from: nameOf(lead.owned_by),
        to: nameOf(trueOwnerId),
      });
      await supabase
        .from('leads')
        .update({ owned_by: trueOwnerId, sourced_by: trueOwnerId, updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    }

    // ── 2. Verify stage is correct based on interactions ───────────────
    const hasCallCompleted = !!lead.call_completed_at;
    const hasCallScheduled = !!lead.call_scheduled_for;
    const callScheduledFuture = hasCallScheduled && new Date(lead.call_scheduled_for!) > new Date();
    const callScheduledPast = hasCallScheduled && new Date(lead.call_scheduled_for!) <= new Date();
    const hasDemoSent = !!lead.demo_sent_at;
    const hasInboundReply = inboundEmails.length > 0;
    const hasCalendarEvent = interactions.some(i =>
      i.metadata && (
        (i.metadata as Record<string, unknown>).calendar_event === true ||
        (i.metadata as Record<string, unknown>).calendar_event_id ||
        (i.metadata as Record<string, unknown>).source === 'calendar_sync'
      )
    );

    // Determine what the stage SHOULD be
    let correctStage = lead.stage;

    // Don't touch stages that are manually set terminal states
    if (['paused', 'dead', 'active_user', 'feedback_call'].includes(lead.stage)) {
      continue; // skip stage verification for these
    }

    if (hasDemoSent) {
      correctStage = 'demo_sent';
    } else if (hasCallCompleted || (callScheduledPast && hasCalendarEvent)) {
      correctStage = 'call_completed';
    } else if (callScheduledFuture) {
      correctStage = 'scheduled';
    } else if (hasCallScheduled && callScheduledPast && !hasCallCompleted) {
      // Call was scheduled but never marked completed — likely happened
      correctStage = 'call_completed';
    } else if (hasInboundReply) {
      // Has a reply but no call info — stay at replied or scheduling
      // If currently at scheduling, keep it (manual advancement)
      if (lead.stage === 'scheduling') {
        correctStage = 'scheduling';
      } else if (['scheduled', 'call_completed', 'demo_sent'].includes(lead.stage)) {
        // Don't regress from a more advanced stage
        correctStage = lead.stage;
      } else {
        correctStage = 'replied';
      }
    }

    if (correctStage !== lead.stage) {
      changes.push({
        lead: lead.contact_name,
        company: lead.company_name,
        field: 'stage',
        from: lead.stage,
        to: correctStage,
      });
      const stageUpdates: Record<string, unknown> = {
        stage: correctStage,
        updated_at: new Date().toISOString(),
      };
      // If advancing to call_completed and no timestamp, set it
      if (correctStage === 'call_completed' && !lead.call_completed_at && lead.call_scheduled_for) {
        stageUpdates.call_completed_at = lead.call_scheduled_for;
      }
      await supabase.from('leads').update(stageUpdates).eq('id', lead.id);
    }
  }

  return NextResponse.json({
    success: true,
    leads_checked: allLeads.length,
    changes_made: changes.length,
    changes,
  });
}
