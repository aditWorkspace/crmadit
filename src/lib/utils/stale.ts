import { STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';

interface LeadForStaleCheck {
  stage: string;
  last_contact_at: string | null;
}

export function isLeadStale(lead: LeadForStaleCheck): boolean {
  const threshold = STALE_THRESHOLDS[lead.stage as LeadStage];
  if (!threshold || !lead.last_contact_at) return false;
  const hoursSinceContact = (Date.now() - new Date(lead.last_contact_at).getTime()) / (1000 * 60 * 60);
  return hoursSinceContact > threshold;
}

export function getStaleSeverity(lead: LeadForStaleCheck): 'warning' | 'critical' | null {
  const threshold = STALE_THRESHOLDS[lead.stage as LeadStage];
  if (!threshold || !lead.last_contact_at) return null;
  const hoursSinceContact = (Date.now() - new Date(lead.last_contact_at).getTime()) / (1000 * 60 * 60);
  if (hoursSinceContact > threshold * 2) return 'critical';
  if (hoursSinceContact > threshold) return 'warning';
  return null;
}

export function countStaleLeads(leads: LeadForStaleCheck[]): number {
  return leads.filter(isLeadStale).length;
}
