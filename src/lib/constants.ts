import { LeadStage, Priority } from '@/types';

// Canonical forward progression — used for velocity tracking and stage comparisons
export const STAGE_ORDER: LeadStage[] = [
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'demo_sent',
  'feedback_call',
  'active_user',
  'paused',
  'dead',
];

// Stages that count as "active" in the pipeline (not terminal, not legacy)
export const ACTIVE_STAGES: LeadStage[] = [
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'demo_sent',
  'feedback_call',
  'active_user',
];

// Three-tier model routing — the rule is volume, not stakes. As of 2026-06 all
// text models call the Anthropic API DIRECTLY (ids start with `claude-`, routed
// in openrouter.ts) so our Anthropic credits are what get consumed — not
// OpenRouter. DeepSeek/Qwen are fully retired here.
//   - TRIAGE_MODEL   Haiku 4.5. Hot-path per-email calls (hundreds-to-thousands
//                    a day). Cheap ($1/$5 per MTok) and fast.
//   - DECIDER_MODEL  Haiku 4.5. Low-volume backend decisions where accuracy
//                    matters (first-reply auto-send classification, 48h
//                    followup should-send). JSON mode via prompt + post-strip.
//   - WRITER_MODEL   Haiku 4.5. Every outbound prose body (first-reply,
//                    fast-loop, info-reply, 48h followup). Warm voice.
export const TRIAGE_MODEL = 'claude-haiku-4-5';
export const DECIDER_MODEL = 'claude-haiku-4-5';
export const WRITER_MODEL = 'claude-haiku-4-5';

// Legacy alias. Four callers still import this name (sync.ts, reply-classifier,
// lead-scoring, generate-templates). Pointed at TRIAGE_MODEL (now Haiku 4.5) so
// those high-volume paths auto-route without touching their code.
export const QWEN_FREE_MODEL = TRIAGE_MODEL;

// Legacy alias from the pre-split era — pre-split the classifier wrote prose,
// so CLASSIFIER_MODEL was Haiku. New code should import DECIDER_MODEL directly.
export const CLASSIFIER_MODEL = DECIDER_MODEL;

// Insights-chat debate pipeline. Migrated 2026-06 from DeepSeek-only to Claude
// (direct Anthropic) along with the rest of the stack — the earlier
// "DeepSeek everywhere, no Anthropic" preference was superseded.
//   - CHAT_ROUTER_MODEL   Haiku 4.5. Classifies bucket + emits FTS terms.
//   - LOOKUP_MODEL        Haiku 4.5. Single-call path for factual questions
//                          and per-transcript filter classifier.
//   - ADVOCATE_MODEL      Haiku 4.5. FOR/AGAINST advocates in scope debates.
//   - JUDGE_MODEL         Sonnet 4.6. Higher-reasoning model for the deliberation.
export const CHAT_ROUTER_MODEL = DECIDER_MODEL;
export const LOOKUP_MODEL = 'claude-haiku-4-5';
export const ADVOCATE_MODEL = 'claude-haiku-4-5';
export const JUDGE_MODEL = 'claude-sonnet-4-6';

// Fast-loop follow-up window (in minutes from the original auto-reply).
// Clamped to the business-hours window by pickFastLoopTime.
export const FAST_LOOP_MIN_MINUTES = 30;
export const FAST_LOOP_MAX_MINUTES = 120;

// Public booking link. Auto-responder interpolates this into positive_book
// replies; the next-step card "Copy Booking Link" button copies this; the
// internal /calendar admin view links here as the shareable URL.
// Switched from the in-house /book page to cal.com on 2026-05-15 per
// product call — cal.com handles availability + email confirmations +
// rescheduling natively and the in-house page accumulated edge cases.
// The /book page route + /api/calendar/book API still exist as dead code
// (legacy in-flight reschedule links may still hit them).
export const BOOKING_URL = 'https://cal.com/adit-mittal/30min';

// Stages where auto-emails are suppressed (call is happening or just done)
export const CALLS_STAGES: LeadStage[] = ['scheduled', 'call_completed', 'feedback_call', 'active_user'];

export const STAGE_LABELS: Record<LeadStage, string> = {
  outreach_sent: 'Cold Email Sent',
  replied: 'In Dialogue',
  scheduling: 'Scheduling Call',
  scheduled: 'Call Scheduled',
  call_completed: 'Discovery Call Done',
  post_call: 'Post Call',           // legacy label — hidden from active flow
  demo_sent: 'Demo Sent',
  feedback_call: 'Feedback Call',
  active_user: 'Weekly Calls',
  paused: 'Paused',
  dead: 'Dead',
};

export const STAGE_COLORS: Record<LeadStage, string> = {
  outreach_sent: 'bg-slate-100 text-slate-700 border-slate-200',
  replied: 'bg-blue-100 text-blue-800 border-blue-200',
  scheduling: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  scheduled: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  call_completed: 'bg-purple-100 text-purple-800 border-purple-200',
  post_call: 'bg-orange-100 text-orange-800 border-orange-200',  // legacy
  demo_sent: 'bg-teal-100 text-teal-800 border-teal-200',
  feedback_call: 'bg-pink-100 text-pink-800 border-pink-200',
  active_user: 'bg-green-100 text-green-800 border-green-200',
  paused: 'bg-gray-100 text-gray-600 border-gray-200',
  dead: 'bg-red-50 text-red-600 border-red-200',
};

export const STAGE_DOT_COLORS: Record<LeadStage, string> = {
  outreach_sent: 'bg-slate-400',
  replied: 'bg-blue-500',
  scheduling: 'bg-yellow-500',
  scheduled: 'bg-indigo-500',
  call_completed: 'bg-purple-500',
  post_call: 'bg-orange-400',     // legacy
  demo_sent: 'bg-teal-500',
  feedback_call: 'bg-pink-500',
  active_user: 'bg-green-500',
  paused: 'bg-gray-400',
  dead: 'bg-red-400',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-400',
  low: 'bg-gray-400',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const SPEED_COLOR = (hrs: number): string => {
  if (hrs < 2) return 'text-green-600';
  if (hrs < 8) return 'text-yellow-600';
  if (hrs < 24) return 'text-orange-600';
  return 'text-red-600';
};

export const STALE_THRESHOLDS: Partial<Record<LeadStage, number>> = {
  replied: 4,              // 4h — respond fast when they're in dialogue
  scheduling: 48,          // 48h — follow up if scheduling stalls
  call_completed: 6,       // 6h — send demo quickly after discovery call
  demo_sent: 3 * 24,       // 3 days — check if they tried the demo
  feedback_call: 7 * 24,   // 7 days — schedule the feedback call
  active_user: 7 * 24,     // 7 days — weekly calls, so alert if no contact in a week
};

// Team names are seeded in the DB — do not add business logic that depends on these strings.
// Kept only as a reference for the initial DB seed.
export const TEAM_NAMES = ['Adit', 'Srijay', 'Asim'] as const;
