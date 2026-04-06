import { getGmailClientForMember } from './client';

export async function sendReplyInThread({
  teamMemberId,
  threadId,
  to,
  subject,
  body,
}: {
  teamMemberId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
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
    '',
    body,
  ];
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
