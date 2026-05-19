// Dripify-specific status enum + display tokens. Kept separate from the
// global STAGE_LABELS/STAGE_COLORS in src/lib/constants.ts so the cold-pool
// pipeline can't accidentally render Dripify states.

import type { DripifyLeadStatus } from './types';

export const DRIPIFY_STATUS_LABELS: Record<DripifyLeadStatus, string> = {
  pending_enrich: 'Resolving Email',
  unresolvable:   'No Email Found',
  email_queued:   'Email Queued',
  sent:           'Email Sent',
  send_failed:    'Send Failed',
  replied:        'Replied',
  skipped:        'Skipped',
};

export const DRIPIFY_STATUS_COLORS: Record<DripifyLeadStatus, string> = {
  pending_enrich: 'bg-amber-100 text-amber-800 border-amber-200',
  unresolvable:   'bg-gray-100 text-gray-700 border-gray-200',
  email_queued:   'bg-blue-100 text-blue-800 border-blue-200',
  sent:           'bg-emerald-100 text-emerald-800 border-emerald-200',
  send_failed:    'bg-red-100 text-red-800 border-red-200',
  replied:        'bg-purple-100 text-purple-800 border-purple-200',
  skipped:        'bg-gray-100 text-gray-500 border-gray-200',
};

export const DRIPIFY_STATUS_ORDER: DripifyLeadStatus[] = [
  'pending_enrich',
  'email_queued',
  'sent',
  'replied',
  'unresolvable',
  'send_failed',
  'skipped',
];
