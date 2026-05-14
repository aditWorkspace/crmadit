// Pure send function: takes a queue row + variant + founder + send mode,
// builds the RFC 2822 message, calls (or skips) the Gmail API, and
// returns a tagged outcome. The caller (tick handler) is responsible for
// DB writes based on the outcome. See spec §6 step ⑤ + §11.6 send modes.

import { renderTemplate } from './render-template';
import type { CampaignGmailClient } from '@/lib/gmail/client';
import type { SendMode } from './types';

export interface SendInput {
  queueRow: {
    id: string;
    account_id: string;
    recipient_email: string;
    recipient_name: string | null;
    recipient_company: string | null;
    template_variant_id: string;
    send_at: string;
    status: 'pending';
  };
  variant: {
    subject_template: string;
    body_template: string;
  };
  founder: {
    id: string;
    name: string;
    email: string;
  };
  sendMode: SendMode;
  allowlist: string[];
}

export type SendOutcome =
  | { outcome: 'sent';            gmail_message_id: string; gmail_thread_id: string | null;
      rendered_subject: string;   rendered_body: string }
  | { outcome: 'skipped';         last_error: string }
  | { outcome: 'rate_limit_retry' }
  | { outcome: 'account_pause';   reason: string }
  | { outcome: 'hard_bounce';     code: number; reason: string }
  | { outcome: 'soft_bounce';     code: number; reason: string }
  | { outcome: 'failed';          last_error: string };

export async function sendCampaignEmail(
  input: SendInput,
  gmail: CampaignGmailClient
): Promise<SendOutcome> {
  // ── Send-mode gating ────────────────────────────────────────────────────
  if (input.sendMode === 'allowlist') {
    const allowlistLower = input.allowlist.map(e => e.toLowerCase());
    if (!allowlistLower.includes(input.queueRow.recipient_email.toLowerCase())) {
      return { outcome: 'skipped', last_error: 'not_in_allowlist' };
    }
  }

  // ── Render the template ─────────────────────────────────────────────────
  let rendered: { subject: string; body: string };
  try {
    rendered = renderTemplate({
      subject_template: input.variant.subject_template,
      body_template: input.variant.body_template,
      first_name: input.queueRow.recipient_name,
      company: input.queueRow.recipient_company,
      founder_name: firstName(input.founder.name),
    });
  } catch (err) {
    return { outcome: 'failed', last_error: `render_error: ${(err as Error).message}` };
  }

  // ── Build the RFC 2822 message ──────────────────────────────────────────
  const raw = buildRawMime({
    fromName: input.founder.name,
    fromEmail: input.founder.email,
    toEmail: input.queueRow.recipient_email,
    subject: rendered.subject,
    body: rendered.body,
    queueId: input.queueRow.id,
  });

  // ── dry_run: skip Gmail call entirely, synthesize the id ────────────────
  if (input.sendMode === 'dry_run') {
    return {
      outcome: 'sent',
      gmail_message_id: `dryrun:${input.queueRow.id}`,
      gmail_thread_id: null,
      rendered_subject: rendered.subject,
      rendered_body: rendered.body,
    };
  }

  // ── production / allowlist: real Gmail API call ─────────────────────────
  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return {
      outcome: 'sent',
      gmail_message_id: res.data.id ?? `unknown:${input.queueRow.id}`,
      gmail_thread_id: res.data.threadId ?? null,
      rendered_subject: rendered.subject,
      rendered_body: rendered.body,
    };
  } catch (err) {
    return classifyGmailError(err, input.queueRow.id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function firstName(fullName: string): string {
  return fullName.split(/\s+/)[0] || fullName;
}

interface BuildMimeArgs {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  /** Queue row UUID; embedded in the tracking pixel URL so opens
   *  map back to the specific send. Same UUID stays the message-
   *  identity for the lifetime of this delivery. */
  queueId: string;
}

/** Public base URL for the tracking endpoint. Falls back to the prod
 *  app URL if NEXT_PUBLIC_APP_URL is unset (e.g. in test runs). */
function trackingBaseUrl(): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  return env || 'https://pmcrminternal.vercel.app';
}

/** HTML-escape a string for safe insertion inside an HTML element. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRawMime(args: BuildMimeArgs): string {
  const localPart = args.fromEmail.split('@')[0];
  const domain = args.fromEmail.split('@')[1] ?? '';
  const unsubscribeMailto = `${localPart}+unsubscribe@${domain}`;

  // Tracking pixel — 1×1 transparent PNG served by /api/cron/email-tool/track/[id].
  // `display:none` hides it visually in clients that still render it; some
  // clients ignore the style and show a tiny gap. `alt=""` keeps screen
  // readers quiet. `width=1 height=1` is the floor that most clients still
  // fire a GET for (0×0 is commonly skipped).
  const pixelUrl = `${trackingBaseUrl()}/api/cron/email-tool/track/${args.queueId}.png`;
  const escapedBody = escapeHtml(args.body);
  const htmlBody = `<!doctype html><html><body><div style="white-space:pre-wrap;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;color:#111;line-height:1.5">${escapedBody}</div><img src="${pixelUrl}" alt="" width="1" height="1" style="display:none" /></body></html>`;

  // Multipart boundary — must not appear anywhere in either part body.
  // We use a long random hex string so collisions are effectively impossible.
  // Prefix `=pp` is conventional; some MTAs probe for our identity in here.
  const boundary = `=pp${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

  // Each part: headers, blank line, body. Closing boundary uses `--<b>--`.
  const headers = [
    `From: "${args.fromName}" <${args.fromEmail}>`,
    `To: ${args.toEmail}`,
    `Reply-To: ${args.fromEmail}`,
    `Subject: ${args.subject}`,
    `List-Unsubscribe: <mailto:${unsubscribeMailto}?subject=unsubscribe>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `Precedence: bulk`,
    `X-Priority: 3`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    args.body,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ];

  const lines = [...headers, ``, ...parts];

  return Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function classifyGmailError(err: unknown, queueRowId: string): SendOutcome {
  const e = err as Error & { code?: number; errors?: Array<{ reason?: string }> };
  const code = e.code ?? 0;
  const reason = e.errors?.[0]?.reason ?? '';

  if (code === 429) {
    return { outcome: 'rate_limit_retry' };
  }
  if (code === 403 && (reason === 'dailyLimitExceeded' || reason === 'quotaExceeded')) {
    return { outcome: 'account_pause', reason };
  }
  if (code >= 500 && code <= 599) {
    return { outcome: 'hard_bounce', code, reason };
  }
  if (code >= 400 && code <= 499) {
    return { outcome: 'soft_bounce', code, reason };
  }
  return {
    outcome: 'failed',
    last_error: `unknown_send_error:${code}:${reason || (e.message ?? '?')}:${queueRowId}`,
  };
}
