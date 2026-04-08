import { LeadStage, Priority } from '@/types';

// Canonical forward progression — used for velocity tracking and stage comparisons
export const STAGE_ORDER: LeadStage[] = [
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
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'demo_sent',
  'feedback_call',
  'active_user',
];

export const QWEN_FREE_MODEL = 'google/gemma-4-26b-a4b-it:free';

// Stages where auto-emails are suppressed (call is happening or just done)
export const CALLS_STAGES: LeadStage[] = ['scheduled', 'call_completed', 'feedback_call', 'active_user'];

export const STAGE_LABELS: Record<LeadStage, string> = {
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
