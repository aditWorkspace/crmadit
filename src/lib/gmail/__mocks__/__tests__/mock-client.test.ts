import { describe, it, expect } from 'vitest';
import { MockGmailClient } from '../mock-client';

describe('MockGmailClient', () => {
  it('records send calls + returns synthetic message id on success', async () => {
    const mock = new MockGmailClient();
    const result = await mock.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(
          'From: a@x.com\r\nTo: b@y.com\r\nSubject: hello\r\n\r\nbody text'
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      },
    });
    expect(result.data.id).toMatch(/^mock-msg-/);
    expect(mock.sends).toHaveLength(1);
    expect(mock.sends[0].decoded.from).toBe('a@x.com');
    expect(mock.sends[0].decoded.to).toBe('b@y.com');
    expect(mock.sends[0].decoded.subject).toBe('hello');
    expect(mock.sends[0].decoded.body).toBe('body text');
  });

  it('throws when nextResponse is set to an error', async () => {
    const mock = new MockGmailClient();
    mock.nextResponse = { error: 429, reason: 'userRateLimitExceeded' };
    await expect(
      mock.users.messages.send({ userId: 'me', requestBody: { raw: 'AAA' } })
    ).rejects.toMatchObject({ code: 429, errors: [{ reason: 'userRateLimitExceeded' }] });
  });

  it('reset() clears sends and restores success', async () => {
    const mock = new MockGmailClient();
    mock.nextResponse = { error: 500 };
    mock.reset();
    expect(mock.nextResponse).toBe('success');
    const result = await mock.users.messages.send({ userId: 'me', requestBody: { raw: 'AAA' } });
    expect(result.data.id).toMatch(/^mock-msg-/);
    expect(mock.sends).toHaveLength(1);
  });

  it('decodes List-Unsubscribe header from raw MIME', async () => {
    const mock = new MockGmailClient();
    const raw = Buffer.from([
      'From: a@x.com',
      'To: b@y.com',
      'Subject: hi',
      'List-Unsubscribe: <mailto:a+unsubscribe@x.com>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      '',
      'body',
    ].join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await mock.users.messages.send({ userId: 'me', requestBody: { raw } });
    expect(mock.sends[0].decoded.listUnsubscribe).toBe('<mailto:a+unsubscribe@x.com>');
    expect(mock.sends[0].decoded.listUnsubscribePost).toBe('List-Unsubscribe=One-Click');
  });
});
