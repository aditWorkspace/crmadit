// Dripify lead processor. Drains pending_enrich → email_queued → sent in a
// single pass. Reuses the existing email-tool enrichment pipeline (BEC + Icypeas
// via processEnrichRow) and Gmail sender (sendCampaignEmail) — no new external
// integrations, no new API costs beyond what cold-pool already incurs.
//
// Pipeline:
//   pending_enrich  → if resolvable → email_queued (resolved_email set)
//                   → else          → unresolvable
//   email_queued    → send via Gmail → sent (gmail_*_id set)
//                                    → send_failed (last_error set)
//
// Test ping handling: Dripify's "Test" button uses a hardcoded Bill Gates
// payload (linkedin_url contains "williamhgates"). Sending the rendered
// template to b.gates@microsoft.com would hard-bounce — instead we redirect
// the recipient to DRIPIFY_TEST_RECIPIENT_OVERRIDE (or aditmittalhs@gmail.com
// as a built-in fallback) so the operator sees a real email arrive.

import type { createAdminClient } from '@/lib/supabase/admin';
import { processEnrichRow } from '@/lib/email-tool/enrich-engine';
import type { EnrichOutcome } from '@/lib/email-tool/enrich-engine';
import { sendCampaignEmail } from '@/lib/email-tool/send';
import { getCampaignGmailClient } from '@/lib/gmail/client';

type Supa = ReturnType<typeof createAdminClient>;

// Adit's team_member_id. Hardcoded because the plan scopes the sender to one
// founder. To rotate or share with Asim later, swap this for a query against
// team_members.
const ADIT_FOUNDER_ID = '81e3b472-0359-4065-a626-c87b678dd556';
const TEST_RECIPIENT_FALLBACK = 'aditmittalhs@gmail.com';

interface DripifyLeadRow {
  id: string;
  status: 'pending_enrich' | 'email_queued' | 'sent' | 'send_failed' | 'unresolvable' | 'replied' | 'skipped';
  linkedin_url: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  company_name: string | null;
  company_url: string | null;
  company_domain: string | null;
  resolved_email: string | null;
  enrich_attempts: number;
  raw_webhook_payload: Record<string, unknown> | null;
}

interface FounderRow {
  id: string;
  name: string;
  email: string;
}

interface VariantRow {
  id: string;
  subject_template: string;
  body_template: string;
}

// Read the four candidate emails Dripify provides in priority order. The
// first non-empty string wins. Order is informed-trust:
//   corporateEmail > email > linkedInEmail > manualEmail
// corporateEmail = Dripify's enrichment (most reliable), email = Dripify's
// "best of all sources" composite, linkedInEmail = pulled from public LI
// profile (rare), manualEmail = whatever was uploaded with the lead.
function pickDripifyProvidedEmail(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const key of ['corporateEmail', 'email', 'linkedInEmail', 'manualEmail']) {
    const v = payload[key];
    if (typeof v === 'string' && v.includes('@') && v.trim().length > 3) return v.trim();
  }
  return null;
}

// Extract bare hostname from a URL (https://www.acme.com/about → acme.com).
function extractHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// Dripify's Test button always sends a fixed Bill Gates payload. Detecting it
// by the LinkedIn URL substring is cheap and robust — Dripify uses the same
// williamhgates URL across all account configs.
function isDripifyTestLead(linkedinUrl: string | null): boolean {
  if (!linkedinUrl) return false;
  return linkedinUrl.toLowerCase().includes('williamhgates');
}

// ── Step A: enrich ────────────────────────────────────────────────────────
async function enrichOne(supabase: Supa, lead: DripifyLeadRow): Promise<{
  status: 'email_queued' | 'unresolvable';
  resolved_email: string | null;
  outcome: EnrichOutcome;
}> {
  const givenEmail = pickDripifyProvidedEmail(lead.raw_webhook_payload);
  const domain = lead.company_domain ?? extractHostname(lead.company_url);
  const fullName = lead.full_name
    ?? [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
    ?? null;

  // processEnrichRow:
  //   - if given_email is provided, BEC-verifies it first (skips Icypeas on pass)
  //   - else tries firstName.lastname@domain patterns via BEC
  //   - else falls through to Icypeas multi-tier (~$0.005–0.05 per lead)
  // The pre-dedupe check (email_pool already has this first_name+company)
  // doesn't impact us — it just means processEnrichRow returns early with
  // status='kept' and final_email=null. We treat null final_email as
  // unresolvable so the dripify_leads row gets flagged for retry.
  const outcome = await processEnrichRow({
    row_index: 0,
    first_name: lead.first_name,
    full_name: fullName || null,
    company: lead.company_name,
    domain,
    given_email: givenEmail,
  }, supabase);

  if (outcome.status === 'kept' && outcome.final_email) {
    return { status: 'email_queued', resolved_email: outcome.final_email, outcome };
  }
  return { status: 'unresolvable', resolved_email: null, outcome };
}

// ── Step B: send ──────────────────────────────────────────────────────────
async function sendOne(supabase: Supa, lead: DripifyLeadRow): Promise<{
  ok: boolean;
  gmail_message_id?: string;
  gmail_thread_id?: string | null;
  rendered_subject?: string;
  rendered_body?: string;
  last_error?: string;
}> {
  if (!lead.resolved_email) return { ok: false, last_error: 'no_resolved_email' };

  // Load founder + active dripify variant in parallel.
  const [founderRes, variantRes] = await Promise.all([
    supabase
      .from('team_members')
      .select('id, name, email, gmail_connected')
      .eq('id', ADIT_FOUNDER_ID)
      .single(),
    supabase
      .from('email_template_variants')
      .select('id, subject_template, body_template')
      .eq('founder_id', ADIT_FOUNDER_ID)
      .eq('audience', 'dripify')
      .eq('is_active', true)
      .eq('is_followup', false)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const founderRow = founderRes.data as (FounderRow & { gmail_connected: boolean }) | null;
  if (!founderRow) return { ok: false, last_error: 'founder_not_found' };
  if (!founderRow.gmail_connected) return { ok: false, last_error: 'founder_gmail_disconnected' };
  const variant = variantRes.data as VariantRow | null;
  if (!variant) return { ok: false, last_error: 'no_active_dripify_template' };

  // Test-ping recipient override. Dripify's Test sends a Bill Gates payload
  // with bogus microsoft.com emails — sending to those would hard-bounce.
  // Redirect to a real inbox so the operator can verify delivery.
  let recipient = lead.resolved_email;
  if (isDripifyTestLead(lead.linkedin_url)) {
    recipient = process.env.DRIPIFY_TEST_RECIPIENT_OVERRIDE || TEST_RECIPIENT_FALLBACK;
  }

  const gmail = await getCampaignGmailClient(founderRow.id);
  const queueRowId = `dripify-${lead.id}`;
  const outcome = await sendCampaignEmail({
    queueRow: {
      id: queueRowId,
      account_id: founderRow.id,
      recipient_email: recipient,
      recipient_name: lead.first_name,
      recipient_company: lead.company_name,
      template_variant_id: variant.id,
      send_at: new Date().toISOString(),
      status: 'pending',
    },
    variant: { subject_template: variant.subject_template, body_template: variant.body_template },
    founder: { id: founderRow.id, name: founderRow.name, email: founderRow.email },
    sendMode: 'production',
    allowlist: [],
  }, gmail);

  if (outcome.outcome === 'sent') {
    return {
      ok: true,
      gmail_message_id: outcome.gmail_message_id,
      gmail_thread_id: outcome.gmail_thread_id,
      rendered_subject: outcome.rendered_subject,
      rendered_body: outcome.rendered_body,
    };
  }
  if (outcome.outcome === 'skipped' || outcome.outcome === 'failed') {
    return { ok: false, last_error: outcome.last_error };
  }
  if (outcome.outcome === 'rate_limit_retry') {
    return { ok: false, last_error: 'rate_limit_retry' };
  }
  if (outcome.outcome === 'hard_bounce' || outcome.outcome === 'soft_bounce') {
    return { ok: false, last_error: `${outcome.outcome}:${outcome.code}:${outcome.reason}` };
  }
  if (outcome.outcome === 'account_pause') {
    return { ok: false, last_error: `account_pause:${outcome.reason}` };
  }
  return { ok: false, last_error: 'unknown_outcome' };
}

// ── Public entry point ────────────────────────────────────────────────────
export type ProcessResult =
  | { lead_id: string; phase: 'enriched';   status: 'email_queued' }
  | { lead_id: string; phase: 'enriched';   status: 'unresolvable'; reason: string }
  | { lead_id: string; phase: 'sent';       status: 'sent' }
  | { lead_id: string; phase: 'send_failed'; status: 'send_failed'; last_error: string }
  | { lead_id: string; phase: 'skipped';    status: 'skipped'; reason: string }
  | { lead_id: string; phase: 'error';      error: string };

export async function processDripifyLead(supabase: Supa, leadId: string): Promise<ProcessResult> {
  try {
    const { data, error } = await supabase
      .from('dripify_leads')
      .select('id, status, linkedin_url, first_name, last_name, full_name, company_name, company_url, company_domain, resolved_email, enrich_attempts, raw_webhook_payload')
      .eq('id', leadId)
      .single();
    if (error || !data) {
      return { lead_id: leadId, phase: 'error', error: error?.message ?? 'lead_not_found' };
    }
    const lead = data as DripifyLeadRow;

    if (lead.status === 'pending_enrich') {
      const result = await enrichOne(supabase, lead);
      await supabase
        .from('dripify_leads')
        .update({
          status: result.status,
          resolved_email: result.resolved_email,
          enrich_outcome: result.outcome as unknown as Record<string, unknown>,
          enrich_attempts: (lead.enrich_attempts ?? 0) + 1,
          last_attempt_at: new Date().toISOString(),
          last_error: result.status === 'unresolvable' ? (result.outcome.icypeas_status ?? result.outcome.status) : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId);
      if (result.status === 'email_queued') {
        return { lead_id: leadId, phase: 'enriched', status: 'email_queued' };
      }
      return {
        lead_id: leadId,
        phase: 'enriched',
        status: 'unresolvable',
        reason: result.outcome.icypeas_status ?? result.outcome.status,
      };
    }

    if (lead.status === 'email_queued') {
      const result = await sendOne(supabase, lead);
      if (result.ok) {
        await supabase
          .from('dripify_leads')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            gmail_message_id: result.gmail_message_id,
            gmail_thread_id: result.gmail_thread_id,
            rendered_subject: result.rendered_subject,
            rendered_body: result.rendered_body,
            assigned_to: ADIT_FOUNDER_ID,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', leadId);
        return { lead_id: leadId, phase: 'sent', status: 'sent' };
      }
      await supabase
        .from('dripify_leads')
        .update({
          status: 'send_failed',
          last_error: result.last_error ?? 'unknown_send_error',
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId);
      return { lead_id: leadId, phase: 'send_failed', status: 'send_failed', last_error: result.last_error ?? 'unknown' };
    }

    return { lead_id: leadId, phase: 'skipped', status: 'skipped', reason: `status=${lead.status}` };
  } catch (err) {
    const e = err as Error;
    await supabase
      .from('dripify_leads')
      .update({ last_error: `crash:${e.message}`, last_attempt_at: new Date().toISOString() })
      .eq('id', leadId);
    return { lead_id: leadId, phase: 'error', error: e.message };
  }
}
