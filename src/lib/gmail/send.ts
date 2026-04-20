import { getGmailClientForMember } from './client';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Get the email addresses of all founders except the sender.
 * Used to CC the other co-founders on every *manual* outbound email.
 * Auto-paths (first-reply responder, drained queue) deliberately do NOT
 * CC the other founders — the volume would flood everyone's inboxes.
 */
export async function getOtherFounderEmails(senderMemberId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, email')
    .neq('id', senderMemberId);
  return (members ?? []).map(m => m.email).filter(Boolean);
}

/**
 * Resolve the thread id that belongs to the sender's own Gmail mailbox.
 *
 * Gmail thread ids are scoped per Google account: thread `T_A` in Adit's
 * inbox is a different opaque id from the same conversation's thread in
 * Asim's inbox, even though the underlying RFC messages are identical.
 * If we pass Adit's thread id to Asim's `messages.send`, Gmail can't find
 * it and starts a brand-new thread.
 *
 * The fix is to look up the sender's copy of the conversation by the
 * RFC 5322 Message-Id header (which IS account-agnostic), using Gmail
 * search's `rfc822msgid:` operator.
 *
 * Returns the sender-local threadId, or `undefined` if not found (in
 * which case the caller should fall through to no `threadId` — Gmail
 * will still thread correctly thanks to `In-Reply-To`/`References`).
 */
async function resolveSenderThreadId(
  teamMemberId: string,
  rfcMessageId: string | undefined,
): Promise<string | undefined> {
  if (!rfcMessageId) return undefined;
  // Gmail's query operator wants the bare id, no angle brackets.
  const bareId = rfcMessageId.replace(/^</, '').replace(/>$/, '');
  try {
    const { gmail } = await getGmailClientForMember(teamMemberId);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `rfc822msgid:${bareId}`,
      maxResults: 1,
    });
    const match = res.data.messages?.[0];
    return match?.threadId || undefined;
  } catch {
    return undefined;
  }
}

export async function sendReplyInThread({
  teamMemberId,
  threadId,
  to,
  cc,
  subject,
  body,
  rfcMessageId,
}: {
  teamMemberId: string;
  /** The sender-local thread id if known. If this was synced from a
   *  *different* founder's mailbox, it will NOT match the sender's own
   *  thread id — in that case pass it anyway, we'll try to re-resolve
   *  via RFC Message-Id first and fall back to this. */
  threadId?: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /** Full RFC 5322 Message-Id of the message we're replying to, wrapped in
   *  angle brackets ("<xxx@yyy>"). Used for both In-Reply-To/References
   *  headers and for resolving the sender-local thread id. */
  rfcMessageId?: string;
}): Promise<string> {
  const { gmail } = await getGmailClientForMember(teamMemberId);

  // Prefer a sender-local thread id derived from the RFC Message-Id over the
  // stored one, because the stored id may have come from another founder's
  // inbox. Fall back to the stored id, then to undefined (fresh thread).
  const senderLocalThreadId =
    (await resolveSenderThreadId(teamMemberId, rfcMessageId)) || threadId || undefined;

  // Ensure subject has Re: prefix — Gmail uses subject match as a secondary
  // threading signal when the Message-Id chain is missing/broken.
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const emailLines: string[] = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ];

  if (cc && cc.length > 0) {
    emailLines.splice(1, 0, `Cc: ${cc.join(', ')}`);
  }

  // Threading headers — these are what Gmail actually uses to stitch the
  // reply into the existing conversation. Must be the real RFC Message-Id,
  // not the Gmail API's internal message id.
  if (rfcMessageId) {
    const normalized = rfcMessageId.trim().startsWith('<')
      ? rfcMessageId.trim()
      : `<${rfcMessageId.trim()}>`;
    emailLines.push(`In-Reply-To: ${normalized}`);
    emailLines.push(`References: ${normalized}`);
  }

  emailLines.push('', body);
  const raw = emailLines.join('\r\n');

  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      // Only pass threadId when we resolved it in THIS account. Sending with
      // a stale cross-account id is what caused replies to split into new
      // threads before — without threadId Gmail relies on In-Reply-To, which
      // is correct now.
      ...(senderLocalThreadId ? { threadId: senderLocalThreadId } : {}),
    },
  });

  return res.data.id || '';
}

/**
 * Send a new email (not a thread reply) with BCC recipients.
 * Used for mass outreach — recipients can't see each other.
 * `To:` is set to sender's own email; all leads go in `Bcc:`.
 */
export async function sendBccEmail({
  teamMemberId,
  bccRecipients,
  subject,
  body,
}: {
  teamMemberId: string;
  bccRecipients: string[];
  subject: string;
  body: string;
}): Promise<string> {
  const { gmail } = await getGmailClientForMember(teamMemberId);

  // Get sender's email for the To: field
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const senderEmail = profile.data.emailAddress || '';

  const emailLines = [
    `To: ${senderEmail}`,
    `Bcc: ${bccRecipients.map(e => e.replace(/[\r\n]/g, '')).join(', ')}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = emailLines.join('\r\n');

  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  return res.data.id || '';
}
