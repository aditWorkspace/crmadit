import { LeadStage, Priority } from '@/types';

export const STAGE_ORDER: LeadStage[] = [
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'active_user',
  'paused',
  'dead',
];

export const ACTIVE_STAGES: LeadStage[] = [
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'active_user',
];

export const STAGE_LABELS: Record<LeadStage, string> = {
  replied: 'Replied',
  scheduling: 'Scheduling',
  scheduled: 'Scheduled',
  call_completed: 'Call Completed',
  post_call: 'Post Call',
  demo_sent: 'Demo Sent',
  active_user: 'Active User',
  paused: 'Paused',
  dead: 'Dead',
};

export const STAGE_COLORS: Record<LeadStage, string> = {
  replied: 'bg-blue-100 text-blue-800 border-blue-200',
  scheduling: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  scheduled: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  call_completed: 'bg-purple-100 text-purple-800 border-purple-200',
  post_call: 'bg-orange-100 text-orange-800 border-orange-200',
  demo_sent: 'bg-teal-100 text-teal-800 border-teal-200',
  active_user: 'bg-green-100 text-green-800 border-green-200',
  paused: 'bg-gray-100 text-gray-600 border-gray-200',
  dead: 'bg-red-50 text-red-600 border-red-200',
};

export const STAGE_DOT_COLORS: Record<LeadStage, string> = {
  replied: 'bg-blue-500',
  scheduling: 'bg-yellow-500',
  scheduled: 'bg-indigo-500',
  call_completed: 'bg-purple-500',
  post_call: 'bg-orange-500',
  demo_sent: 'bg-teal-500',
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
  replied: 4,         // hours
  scheduling: 48,
  call_completed: 4,
  post_call: 24,
  demo_sent: 5 * 24,  // 5 days in hours
  active_user: 14 * 24, // 14 days
};

export const TEAM_NAMES = ['Adit', 'Srijay', 'Asim'] as const;
