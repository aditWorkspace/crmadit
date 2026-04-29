import { createAdminClient } from '@/lib/supabase/admin';
import { TEAM_NAMES } from '@/lib/constants';
import type { GranolaCalendarEvent, GranolaAttendee } from './client';

// When the caller passes the full Granola note (calendar_event + attendees),
// the matcher uses those signals first — they're far more reliable than
// parsing the note title. Title parsing is the fallback for notes that are
// missing calendar metadata (Granola sometimes omits it for ad-hoc calls).
//
// Confidence ladder, highest first:
//   DEFINITIVE   — attendee email matches a known lead contact email (after
//                  filtering co-founder emails). Bypasses normal tie-break.
//   DEFINITIVE   — calendar_event.scheduled_start_time is within ±5 minutes
//                  of lead.call_scheduled_for. (Booked meeting time anchor.)
//   STRONG       — company in title AND time within 24h of call timestamp
//                  OR contact full-name in title AND time within 12h of call
//   MEDIUM       — company in title (no time match) AND lead in a call-stage
//                  OR contact full-name in title AND lead in call-stage
//                  OR contact firstname-only in title AND time within 24h
//                  OR contact firstname-only in title + call-stage + ≤7d (reschedule)
//   WEAK         — contact firstname-only in title, no time match (skipped by default)
//   NONE         — skip silently. Personal meetings end up here.
//
// Critical filter: leads whose contact_name matches a team member name
// (Adit / Srijay / Asim) are excluded entirely — those would otherwise
// catch every title containing a co-founder's name, which is most of them.
// Co-founder emails are also stripped from the attendee list before email
// matching, otherwise every internal call would match every lead.

// Wider than you'd think: Granola's note created_at is when the call
// HAPPENED, but lead.call_scheduled_for / call_completed_at can drift
// (rescheduled, manually re-entered, time-zone slop). 24h+ is generous
// without being permissive — the title still has to contain the
// company or full contact name for these windows to apply.
const STRONG_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;      // 24h
const TIGHT_TIME_WINDOW_MS = 12 * 60 * 60 * 1000;       // 12h
// Used only for the contact-first-name medium tier. Designed to absorb
// reschedules: if a call originally scheduled for Thursday gets pushed to
// next Tuesday and the founder never updates call_scheduled_for /
// call_completed_at, the Granola note (created Tue) is still ~5 days from
// the stored time. 7 days covers typical reschedule slop without
// becoming permissive — first-name-only is still gated on the lead being
// in a CALL_STAGE.
const RESCHEDULE_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Tight window for matching the booked meeting time against
// lead.call_scheduled_for. ±5 min is enough to absorb time-zone slop and
// floating-point timestamp jitter without ever colliding with a different
// real meeting.
const SCHEDULED_TIME_WINDOW_MS = 5 * 60 * 1000;          // 5 min
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
  contact_email: string | null;
  company_name: string | null;
  call_scheduled_for: string | null;
  call_completed_at: string | null;
  stage: string;
  updated_at: string | null;
}

export interface NoteRichSignals {
  calendarEvent?: GranolaCalendarEvent | null;
  attendees?: GranolaAttendee[];
}

export async function matchNoteToLead(
  noteTitle: string | null,
  noteCreatedAt: string,
  rich?: NoteRichSignals,
): Promise<MatchedLead | null> {
  const supabase = createAdminClient();

  // Pull leads + their alternate emails (lead_contacts) + team-member emails
  // in parallel. We need the team emails to filter co-founders out of the
  // attendee list before email-matching.
  const [leadsRes, contactsRes, teamRes] = await Promise.all([
    supabase
      .from('leads')
      .select('id, contact_name, contact_email, company_name, call_scheduled_for, call_completed_at, stage, updated_at')
      .eq('is_archived', false),
    supabase.from('lead_contacts').select('lead_id, email'),
    supabase.from('team_members').select('email'),
  ]);

  const leads = (leadsRes.data || []) as LeadRow[];
  if (!leads.length) return null;

  // Build per-lead set of all known emails (primary + alternates).
  const leadEmails = new Map<string, Set<string>>();   // lead_id -> Set<lower email>
  for (const lead of leads) {
    const set = new Set<string>();
    if (lead.contact_email) set.add(lead.contact_email.trim().toLowerCase());
    leadEmails.set(lead.id, set);
  }
  for (const row of (contactsRes.data || []) as Array<{ lead_id: string; email: string }>) {
    const set = leadEmails.get(row.lead_id);
    if (set && row.email) set.add(row.email.trim().toLowerCase());
  }
  const teamEmailSet = new Set(
    ((teamRes.data || []) as Array<{ email: string }>).map(r => r.email.trim().toLowerCase()),
  );

  // ─── DEFINITIVE TIER ─────────────────────────────────────────────────
  // (A) Email match: any non-team attendee email matches any known email
  // for any lead. This is the strongest possible signal and overrides
  // everything else.
  const attendeeEmails = collectExternalAttendeeEmails(rich, teamEmailSet);
  if (attendeeEmails.size) {
    const emailMatches: LeadRow[] = [];
    for (const lead of leads) {
      const knownEmails = leadEmails.get(lead.id);
      if (!knownEmails?.size) continue;
      for (const e of attendeeEmails) {
        if (knownEmails.has(e)) {
          emailMatches.push(lead);
          break;
        }
      }
    }
    if (emailMatches.length === 1) {
      const lead = emailMatches[0];
      const matchedEmail = [...attendeeEmails].find(e => leadEmails.get(lead.id)?.has(e));
      return {
        lead_id: lead.id,
        contact_name: lead.contact_name || 'Unknown',
        company_name: lead.company_name || 'Unknown',
        confidence: 'strong',
        reason: `attendee email "${matchedEmail}" matches lead`,
      };
    }
    if (emailMatches.length > 1) {
      // Multiple leads share an attendee email — almost certainly the same
      // person represented by duplicate-lead rows (e.g. our Bg Networks /
      // Bgnetworks pair). Pick the most-recently-updated.
      emailMatches.sort((a, b) => {
        const ua = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const ub = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return ub - ua;
      });
      const winner = emailMatches[0];
      const others = emailMatches.slice(1).map(l => `${l.company_name} (${l.id.slice(0, 8)})`).join(', ');
      return {
        lead_id: winner.id,
        contact_name: winner.contact_name || 'Unknown',
        company_name: winner.company_name || 'Unknown',
        confidence: 'strong',
        reason: `attendee email match across duplicate leads — picked most-recent over: ${others}`,
      };
    }
  }

  // (B) Scheduled-time match: lead.call_scheduled_for within ±5 min of the
  // booked meeting's scheduled_start_time. This nails the exact-time check
  // the user asked for. Title doesn't need to mention anything.
  const scheduledStart = rich?.calendarEvent?.scheduled_start_time
    ? new Date(rich.calendarEvent.scheduled_start_time).getTime()
    : null;
  if (scheduledStart && !Number.isNaN(scheduledStart)) {
    const timeMatches = leads.filter(l => {
      if (!l.call_scheduled_for) return false;
      const callT = new Date(l.call_scheduled_for).getTime();
      if (Number.isNaN(callT)) return false;
      // Skip co-founder leads — defensive, shouldn't happen in practice.
      const first = (l.contact_name || '').trim().toLowerCase().split(/\s+/)[0] || '';
      if (TEAM_NAME_LOWER.has(first)) return false;
      return Math.abs(callT - scheduledStart) <= SCHEDULED_TIME_WINDOW_MS;
    });
    if (timeMatches.length === 1) {
      const lead = timeMatches[0];
      return {
        lead_id: lead.id,
        contact_name: lead.contact_name || 'Unknown',
        company_name: lead.company_name || 'Unknown',
        confidence: 'strong',
        reason: `lead.call_scheduled_for matches booked meeting start within ±5min`,
      };
    }
    if (timeMatches.length > 1) {
      // Same-time dupe leads: pick most-recently-updated.
      timeMatches.sort((a, b) => {
        const ua = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const ub = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return ub - ua;
      });
      const winner = timeMatches[0];
      const others = timeMatches.slice(1).map(l => `${l.company_name} (${l.id.slice(0, 8)})`).join(', ');
      return {
        lead_id: winner.id,
        contact_name: winner.contact_name || 'Unknown',
        company_name: winner.company_name || 'Unknown',
        confidence: 'strong',
        reason: `scheduled-time ±5min match across duplicate leads — picked most-recent over: ${others}`,
      };
    }
  }

  // ─── TITLE-BASED FALLBACK (legacy logic) ─────────────────────────────
  const title = (noteTitle || '').toLowerCase();
  if (!title) return null;

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
    // Reschedule resilience: first-name in title + call-stage + call time
    // within 7 days. Catches the case where the call was pushed to a later
    // date and the founder never updated call_scheduled_for. Still strict
    // enough that a 6-month-old call_completed lead won't accidentally
    // capture an unrelated "Colin" note.
    if (contactFirstHit && stageIsCall && closestDelta <= RESCHEDULE_TIME_WINDOW_MS) {
      candidates.push({ lead, confidence: 'medium', timeDelta: closestDelta, reason: `contact first-name "${contactFirst}" + call ±${formatDelta(closestDelta)} (reschedule window) + lead stage=${lead.stage}` });
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
  // times, normally refuse rather than attach to the wrong lead.
  // EXCEPTION: if every tied candidate shares the SAME normalized contact
  // full-name, they're duplicate-lead rows for the same person (e.g. one
  // for "Bg Networks" + a later auto-created one for "Bgnetworks"). In that
  // case attach to the most-recently-updated lead so the call doesn't
  // silently drop. The matcher logs the dupes in `reason` so the import
  // log makes the situation visible.
  const tied = candidates.filter(c => c.confidence === best.confidence && Math.abs(c.timeDelta - best.timeDelta) < 30 * 60 * 1000);
  if (tied.length > 1) {
    const norm = (s: string | null) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const fullNames = new Set(tied.map(c => norm(c.lead.contact_name)).filter(n => n.includes(' ')));
    const sameFullName = fullNames.size === 1;
    if (!sameFullName) return null;

    tied.sort((a, b) => {
      const ua = a.lead.updated_at ? new Date(a.lead.updated_at).getTime() : 0;
      const ub = b.lead.updated_at ? new Date(b.lead.updated_at).getTime() : 0;
      return ub - ua;
    });
    const winner = tied[0];
    const others = tied.slice(1).map(c => `${c.lead.company_name} (${c.lead.id.slice(0, 8)})`).join(', ');
    return {
      lead_id: winner.lead.id,
      contact_name: winner.lead.contact_name || 'Unknown',
      company_name: winner.lead.company_name || 'Unknown',
      confidence: winner.confidence,
      reason: `${winner.reason} — picked over duplicate lead(s): ${others}`,
    };
  }

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

// Pull every external (non-team) attendee email from the Granola note's
// rich payload. Both `attendees` (top level) and `calendar_event.invitees`
// can carry emails — we union them to be safe, since Granola's payload
// shape varies a little between manual notes and calendar-linked ones.
function collectExternalAttendeeEmails(
  rich: NoteRichSignals | undefined,
  teamEmailSet: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const e = (raw || '').trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    if (teamEmailSet.has(e)) return;
    out.add(e);
  };
  for (const a of rich?.attendees || []) push(a.email);
  for (const inv of rich?.calendarEvent?.invitees || []) push(inv.email);
  return out;
}
