import { createAdminClient } from '@/lib/supabase/admin';
import { TEAM_NAMES } from '@/lib/constants';

// Granola's API doesn't expose attendee emails or calendar event IDs, so we
// match notes to leads by (title substring) + (time proximity).
//
// Confidence ladder, highest first:
//   STRONG  — company in title AND time within 6h of call timestamp
//             OR contact full-name in title AND time within 4h of call
//   MEDIUM  — company in title (no time match) AND lead in a call-stage
//             OR contact full-name (firstname + lastname) in title AND lead in call-stage
//             OR contact firstname-only in title AND time within 6h
//   WEAK    — contact firstname-only in title, no time match (skipped by default)
//   NONE    — skip silently. Personal meetings end up here.
//
// Critical filter: leads whose contact_name matches a team member name
// (Adit / Srijay / Asim) are excluded entirely — those would otherwise
// catch every title containing a co-founder's name, which is most of them.

const STRONG_TIME_WINDOW_MS = 6 * 60 * 60 * 1000;       // 6h
const TIGHT_TIME_WINDOW_MS = 4 * 60 * 60 * 1000;        // 4h
const CALL_STAGES = new Set([
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'feedback_call',
  'active_user',
]);

// Names (lowercased) that should NEVER be treated as a "contact match" because
// they belong to a Proxi co-founder. Includes first names and any common
// extensions; the matcher does substring containment, so first-name coverage
// is enough.
const TEAM_NAME_LOWER = new Set(TEAM_NAMES.map(n => n.toLowerCase()));

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
    const contactFull = (lead.contact_name || '').toLowerCase().trim();
    if (!company && !contactFull) continue;

    // Hard exclude: lead's contact_name is one of the co-founders. Those are
    // never the actual prospect — they're our team showing up as participants.
    const contactFirst = contactFull.split(/\s+/)[0] || '';
    if (TEAM_NAME_LOWER.has(contactFirst)) continue;

    const companyHit = company.length > 2 && title.includes(company);
    const contactFullHit = contactFull.length > 2 && contactFull.includes(' ') && title.includes(contactFull);
    const contactFirstHit = !contactFullHit && contactFirst.length > 2 && title.includes(contactFirst);

    if (!companyHit && !contactFullHit && !contactFirstHit) continue;

    const callTimes = [lead.call_scheduled_for, lead.call_completed_at]
      .filter((x): x is string => !!x)
      .map(t => Math.abs(new Date(t).getTime() - noteTime));
    const closestDelta = callTimes.length ? Math.min(...callTimes) : Number.POSITIVE_INFINITY;
    const stageIsCall = CALL_STAGES.has(lead.stage);

    // Strong: company match + time, OR full-name match + tight time
    if (companyHit && closestDelta <= STRONG_TIME_WINDOW_MS) {
      candidates.push({ lead, confidence: 'strong', timeDelta: closestDelta, reason: `company "${lead.company_name}" + call ±${formatDelta(closestDelta)}` });
      continue;
    }
    if (contactFullHit && closestDelta <= TIGHT_TIME_WINDOW_MS) {
      candidates.push({ lead, confidence: 'strong', timeDelta: closestDelta, reason: `contact full-name "${lead.contact_name}" + call ±${formatDelta(closestDelta)}` });
      continue;
    }

    // Medium: company in title + call-stage; or full-name in title + call-stage;
    // or first-name in title + tight time
    if (companyHit && stageIsCall) {
      candidates.push({ lead, confidence: 'medium', timeDelta: closestDelta, reason: `company "${lead.company_name}" in title; lead stage=${lead.stage}` });
      continue;
    }
    if (contactFullHit && stageIsCall) {
      candidates.push({ lead, confidence: 'medium', timeDelta: closestDelta, reason: `contact full-name "${lead.contact_name}" in title; lead stage=${lead.stage}` });
      continue;
    }
    if (contactFirstHit && closestDelta <= STRONG_TIME_WINDOW_MS) {
      candidates.push({ lead, confidence: 'medium', timeDelta: closestDelta, reason: `contact first-name "${contactFirst}" + call ±${formatDelta(closestDelta)}` });
      continue;
    }

    // Weak: first-name only, no time
    if (contactFirstHit && stageIsCall) {
      candidates.push({ lead, confidence: 'weak', timeDelta: closestDelta, reason: `contact first-name "${contactFirst}" only; lead stage=${lead.stage}` });
    }
  }

  if (!candidates.length) return null;

  const order: Record<MatchConfidence, number> = { strong: 3, medium: 2, weak: 1, none: 0 };
  candidates.sort((a, b) => order[b.confidence] - order[a.confidence] || a.timeDelta - b.timeDelta);

  const best = candidates[0];
  // Tie-break safety: if two leads tie at the SAME confidence with similar
  // times, refuse rather than attach to wrong lead.
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
  if (!isFinite(ms)) return '∞';
  const hrs = ms / (60 * 60 * 1000);
  if (hrs < 1) return `${Math.round(ms / (60 * 1000))}m`;
  return `${hrs.toFixed(1)}h`;
}
