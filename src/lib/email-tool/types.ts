// Shared types for cold-outreach pipeline. Mirrors the schema in
// supabase/migrations/021_email_send_core.sql. See spec §4.1 for
// authoritative column definitions; this file is the consumer-facing
// TypeScript shape.

export type CampaignStatus =
  | 'pending'   // INSERTed; runDailyStart not yet completed all 11 steps
  | 'running'   // queue rows inserted; tick is draining
  | 'done'      // all queue rows reached terminal state
  | 'aborted'   // orphan-recovery sweep fired, OR explicit admin abort
  | 'paused'    // all founders paused mid-campaign
  | 'exhausted' // pool ran out
  | 'skipped';  // skip_next_run was set, so no queue rows

export type QueueStatus =
  | 'pending'   // waiting for slot
  | 'sending'   // tick has claimed it (FOR UPDATE SKIP LOCKED)
  | 'sent'      // Gmail API call succeeded (or synthetic in dry_run)
  | 'failed'    // terminal error (bounce, render fail, etc.)
  | 'skipped';  // pre-send check rejected (replied / not-in-allowlist / etc.)

export type SendMode = 'production' | 'dry_run' | 'allowlist';

export type ContactSource = 'pool' | 'priority';

export type PriorityStatus = 'pending' | 'scheduled' | 'sent' | 'skipped' | 'cancelled';

export type ErrorClass =
  | 'crash'           // uncaught exception in tick handler
  | 'gmail_api_error' // Gmail returned non-success
  | 'render_error'    // template render threw
  | 'config_error'    // missing variant, OAuth invalid, etc.
  | 'timeout'         // tick exceeded budget
  | 'unknown';

export interface EmailSendCampaign {
  id: string;
  idempotency_key: string;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  status: CampaignStatus;
  total_picked: number;
  total_sent: number;
  total_failed: number;
  total_skipped: number;
  abort_reason: string | null;
  warmup_day: number | null;
  send_mode: SendMode;
  created_by: string | null;
  created_at: string;
}

export interface EmailSendQueueRow {
  id: string;
  campaign_id: string;
  account_id: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_company: string | null;
  template_variant_id: string;
  send_at: string;
  status: QueueStatus;
  attempts: number;
  last_error: string | null;
  sending_started_at: string | null;
  sent_at: string | null;
  gmail_message_id: string | null;
  source: ContactSource;
  priority_id: string | null;
  created_at: string;
}

export interface EmailTemplateVariant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailSendSchedule {
  id: 1;
  enabled: boolean;
  send_mode: SendMode;
  warmup_started_on: string | null;
  warmup_day_completed: number;
  skip_next_run: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  crashes_counter_reset_at: string | null;
  updated_at: string;
}

export interface EmailSendPriorityRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  uploaded_by: string;
  uploaded_at: string;
  scheduled_for_date: string;
  notes: string | null;
  override_blacklist: boolean;
  override_owner: string | null;
  status: PriorityStatus;
  campaign_id: string | null;
  last_error: string | null;
}

export interface EmailSendError {
  id: string;
  campaign_id: string | null;
  account_id: string | null;
  queue_row_id: string | null;
  error_class: ErrorClass;
  error_code: string | null;
  error_message: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
}
