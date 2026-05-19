// Shared types for the Dripify integration. The DB enum from migration 036
// mirrors this list — keep them in sync if either changes.

export type DripifyLeadStatus =
  | 'pending_enrich'
  | 'unresolvable'
  | 'email_queued'
  | 'sent'
  | 'send_failed'
  | 'replied'
  | 'skipped';

export interface DripifyLead {
  id: string;
  created_at: string;
  updated_at: string;
  linkedin_url: string | null;
  linkedin_public_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  company_name: string | null;
  company_url: string | null;
  company_domain: string | null;
  dripify_event_type: string;
  dripify_campaign_name: string | null;
  dripify_event_received_at: string;
  status: DripifyLeadStatus;
  resolved_email: string | null;
  enrich_attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  sent_at: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rendered_subject: string | null;
  rendered_body: string | null;
  assigned_to: string | null;
  replied_at: string | null;
  crm_lead_id: string | null;
}
