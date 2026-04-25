import { createAdminClient } from '@/lib/supabase/admin';

// Granola's API doesn't expose attendee emails or calendar event IDs, so we
// match notes to leads by (title substring) + (time proximity).
//
// Confidence ladder, highest first:
//   STRONG  — title contains lead.company_name AND note.created_at is within
//             6h of lead.call_scheduled_for OR lead.call_completed_at
//   MEDIUM  — title contains lead.company_name; lead is in a stage that
//             implies a call has happened
//   WEAK    — title contains contact_name only (no company match) AND lead is
//             in a call-related stage. We still import these but log them.
//   NONE    — skip silently. Personal meetings end up here.
//
// When multiple leads match the same note, we pick the one with the closest
// time match. If still tied, we skip — better to leave the note unimported
// than to attach it to the wrong lead.

const STRONG_TIME_WINDOW_MS = 6 * 60 * 60 * 1000;       // 6h
const CALL_STAGES = new Set([
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'feedback_call',
  'active_user',
]);

export type MatchConfidence = 'strong' | 'medium' | 'weak' | 'none';

export interface MatchedLead {
  lead_id: string;
  contact_name: string;
  company_name: string;
  confidence: MatchConfidence;
  reason: string;
}

interface LeadRow {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  call_scheduled_for: string | null;
  call_completed_at: string | null;
  stage: string;
}

export async function matchNoteToLead(
  noteTitle: string | null,
  noteCreatedAt: string,
): Promise<MatchedLead | null> {
  const title = (noteTitle || '').toLowerCase();
  if (!title) return null;

  const supabase = createAdminClient();
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, call_scheduled_for, call_completed_at, stage')
    .eq('is_archived', false);

  if (!leads?.length) return null;

  const noteTime = new Date(noteCreatedAt).getTime();
  const candidates: Array<{ lead: LeadRow; confidence: MatchConfidence; timeDelta: number; reason: string }> = [];

  for (const lead of leads as LeadRow[]) {
    const company = (lead.company_name || '').toLowerCase().trim();
    const contact = (lead.contact_name || '').toLowerCase().trim();
    if (!company && !contact) continue;

    const companyHit = company.length > 2 && title.includes(company);
    const contactHit = contact.length > 2 && title.includes(contact);
    if (!companyHit && !contactHit) continue;

    const callTimes = [lead.call_scheduled_for, lead.call_completed_at]
      .filter((x): x is string => !!x)
      .map(t => Math.abs(new Date(t).getTime() - noteTime));
    const closestDelta = callTimes.length ? Math.min(...callTimes) : Number.POSITIVE_INFINITY;
    const stageIsCall = CALL_STAGES.has(lead.stage);

    if (companyHit && closestDelta <= STRONG_TIME_WINDOW_MS) {
      candidates.push({ lead, confidence: 'strong', timeDelta: closestDelta, reason: `company "${lead.company_name}" in title; call ±${formatDelta(closestDelta)}` });
    } else if (companyHit && stageIsCall) {
      candidates.push({ lead, confidence: 'medium', timeDelta: closestDelta, reason: `company "${lead.company_name}" in title; lead stage=${lead.stage}` });
    } else if (contactHit && stageIsCall) {
      candidates.push({ lead, confidence: 'weak', timeDelta: closestDelta, reason: `contact "${lead.contact_name}" in title; lead stage=${lead.stage}` });
    }
  }

  if (!candidates.length) return null;

  // Best-confidence wins; ties broken by smallest time delta.
  const order: Record<MatchConfidence, number> = { strong: 3, medium: 2, weak: 1, none: 0 };
  candidates.sort((a, b) => order[b.confidence] - order[a.confidence] || a.timeDelta - b.timeDelta);

  const best = candidates[0];
  // If two leads tie at the SAME confidence with similar times, that's
  // ambiguous — refuse to import rather than attach to the wrong one.
  const tied = candidates.filter(c => c.confidence === best.confidence && Math.abs(c.timeDelta - best.timeDelta) < 30 * 60 * 1000);
  if (tied.length > 1) return null;

  return {
    lead_id: best.lead.id,
    contact_name: best.lead.contact_name || 'Unknown',
    company_name: best.lead.company_name || 'Unknown',
    confidence: best.confidence,
    reason: best.reason,
  };
}

function formatDelta(ms: number): string {
  const hrs = ms / (60 * 60 * 1000);
  if (hrs < 1) return `${Math.round(ms / (60 * 1000))}m`;
  return `${hrs.toFixed(1)}h`;
}
