// Critical-alert dispatcher for the cold-outreach pipeline. Sends a
// Resend email to all 3 founders + writes an activity_log entry +
// emits a structured log line. See spec §11.4.
//
// Use sparingly — only for events that require human attention:
//   • Tick crash threshold reached (3+ crashes / 10 min)
//   • Account paused due to bounce-rate breach
//   • Account paused due to 403 dailyLimitExceeded / quotaExceeded
//   • Orphan campaign aborted
//   • Pool exhausted
//   • All founders paused
//
// Less-critical events (priority overflow, no active variants for one
// founder, daily digest summary) go through the daily digest, not this.

import type { createAdminClient } from '@/lib/supabase/admin';
import { log } from './log';

type Supa = ReturnType<typeof createAdminClient>;

export interface CriticalAlertInput {
  subject: string;
  body: string;
  /** Short event code for activity_log. Snake_case, low cardinality. */
  event: string;
  /** Optional context — included in activity_log details + structured log. */
  context?: Record<string, unknown>;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Send a critical alert. Resilient: if Resend is missing or returns an
 * error, we still write the activity_log + structured log so the signal
 * isn't lost. Caller doesn't await for visibility — alert is fire-and-
 * forget at the call site (e.g., inside an error path that's already
 * doing other work).
 */
export async function sendCriticalAlert(
  supabase: Supa,
  args: CriticalAlertInput,
): Promise<{ sent: boolean; reason?: string }> {
  // Always log + write activity_log first, even if Resend is unavailable
  log('error', `alert_${args.event}`, args.context);

  // activity_log: spec §12.6 says cold_outreach events go here
  await supabase.from('activity_log').insert({
    action: `email_send_alert_${args.event}`,
    details: {
      subject: args.subject,
      body_preview: args.body.slice(0, 500),
      ...(args.context ?? {}),
    },
  }).then(({ error }) => {
    if (error) log('warn', 'alert_activity_log_failed', { err: error.message });
  });

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    log('warn', 'alert_resend_missing_key');
    return { sent: false, reason: 'no_resend_api_key' };
  }

  // Pull founder emails (the 3 hardcoded co-founders)
  const { data: founders } = await supabase
    .from('team_members')
    .select('email')
    .not('email', 'is', null);
  const recipients = ((founders ?? []) as Array<{ email: string }>)
    .map(f => f.email)
    .filter(Boolean);
  if (recipients.length === 0) {
    log('warn', 'alert_no_recipients');
    return { sent: false, reason: 'no_recipients' };
  }

  const fromAddress = process.env.DIGEST_FROM_EMAIL || 'Proxi CRM <digest@proxi.ai>';
  const subject = `🔴 ${args.subject}`;
  const body = renderTextBody(args);

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: recipients,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('warn', 'alert_resend_failed', { status: res.status, body_preview: text.slice(0, 200) });
      return { sent: false, reason: `resend_${res.status}` };
    }
    log('info', 'alert_sent', { event: args.event, recipients: recipients.length });
    return { sent: true };
  } catch (err) {
    log('warn', 'alert_resend_threw', { err: (err as Error).message });
    return { sent: false, reason: 'resend_threw' };
  }
}

function renderTextBody(args: CriticalAlertInput): string {
  const lines: string[] = [args.body, ''];
  if (args.context && Object.keys(args.context).length > 0) {
    lines.push('--- Context ---');
    for (const [k, v] of Object.entries(args.context)) {
      lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('Cold-outreach automation — see /email-tool/admin for status.');
  return lines.join('\n');
}
