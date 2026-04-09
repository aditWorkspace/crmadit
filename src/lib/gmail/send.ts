import { getGmailClientForMember } from './client';

export async function sendReplyInThread({
  teamMemberId,
  threadId,
  to,
  subject,
  body,
  inReplyToMessageId,
}: {
  teamMemberId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  inReplyToMessageId?: string;
}): Promise<string> {
  const { gmail } = await getGmailClientForMember(teamMemberId);

  // Ensure subject has Re: prefix
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  // Build RFC 2822 email
  const emailLines = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ];

  if (inReplyToMessageId) {
    emailLines.push(`In-Reply-To: <${inReplyToMessageId}>`);
    emailLines.push(`References: <${inReplyToMessageId}>`);
  }

  emailLines.push('', body);
  const raw = emailLines.join('\r\n');

  // Base64url encode
  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      threadId,
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
