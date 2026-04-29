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
}

function buildRawMime(args: BuildMimeArgs): string {
  const localPart = args.fromEmail.split('@')[0];
  const domain = args.fromEmail.split('@')[1] ?? '';
  const unsubscribeMailto = `${localPart}+unsubscribe@${domain}`;

  const lines = [
    `From: "${args.fromName}" <${args.fromEmail}>`,
    `To: ${args.toEmail}`,
    `Reply-To: ${args.fromEmail}`,
    `Subject: ${args.subject}`,
    `List-Unsubscribe: <mailto:${unsubscribeMailto}?subject=unsubscribe>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `Precedence: bulk`,
    `X-Priority: 3`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    args.body,
  ];

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
