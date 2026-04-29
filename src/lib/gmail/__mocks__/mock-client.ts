// Test mock for CampaignGmailClient. Records every send call with the
// decoded MIME body so tests can assert on what the pipeline tried to
// send without ever calling Gmail.
//
// Usage in a test:
//   const mock = new MockGmailClient();
//   await sendCampaignEmail({ ..., }, mock);
//   expect(mock.sends[0].decoded.subject).toBe('...');
//
// To simulate Gmail errors:
//   mock.nextResponse = { error: 429, reason: 'userRateLimitExceeded' };
//   const result = await sendCampaignEmail(...); // result.outcome === 'rate_limit_retry'

import type { CampaignGmailClient } from '../client';

export interface MockSendCall {
  userId: string;
  raw: string;
  decoded: {
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
    precedence?: string;
    contentType?: string;
    body?: string;
  };
}

export type MockGmailResponse =
  | 'success'
  | { error: number; reason?: string };

export class MockGmailClient implements CampaignGmailClient {
  public sends: MockSendCall[] = [];
  public nextResponse: MockGmailResponse = 'success';
  private messageIdCounter = 1;

  users = {
    messages: {
      send: async (params: { userId: string; requestBody: { raw: string } }) => {
        const decoded = decodeRawMime(params.requestBody.raw);
        this.sends.push({
          userId: params.userId,
          raw: params.requestBody.raw,
          decoded,
        });
        if (this.nextResponse === 'success') {
          const id = `mock-msg-${this.messageIdCounter++}`;
          return {
            data: { id, threadId: `mock-thread-${id}` },
          };
        }
        // Simulate Gmail API error shape: error has `code` (number) +
        // `errors` array with `reason` strings
        const err = new Error(`mock gmail error ${this.nextResponse.error}`) as Error & {
          code: number;
          errors: Array<{ reason?: string }>;
        };
        err.code = this.nextResponse.error;
        err.errors = [{ reason: this.nextResponse.reason }];
        throw err;
      },
    },
  };

  reset(): void {
    this.sends = [];
    this.nextResponse = 'success';
    this.messageIdCounter = 1;
  }
}

// Decode a base64url-encoded RFC 2822 MIME message into a structured
// shape for test assertions. Only parses the first headers block + body.
function decodeRawMime(raw: string): MockSendCall['decoded'] {
  const decoded = Buffer.from(
    raw.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');

  // Split headers from body at the first blank line (CRLF CRLF or LF LF)
  const splitIdx = decoded.indexOf('\r\n\r\n');
  const altSplit = splitIdx === -1 ? decoded.indexOf('\n\n') : splitIdx;
  const headersBlock = altSplit === -1 ? decoded : decoded.slice(0, altSplit);
  const body = altSplit === -1 ? '' : decoded.slice(altSplit + (splitIdx === -1 ? 2 : 4));

  const headers: Record<string, string> = {};
  for (const line of headersBlock.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headers[name] = value;
  }

  return {
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    listUnsubscribe: headers['list-unsubscribe'],
    listUnsubscribePost: headers['list-unsubscribe-post'],
    precedence: headers.precedence,
    contentType: headers['content-type'],
    body,
  };
}
