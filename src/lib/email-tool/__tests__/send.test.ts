import { describe, it, expect, beforeEach } from 'vitest';
import { sendCampaignEmail } from '../send';
import { MockGmailClient } from '@/lib/gmail/__mocks__/mock-client';

describe('sendCampaignEmail', () => {
  let mock: MockGmailClient;
  beforeEach(() => { mock = new MockGmailClient(); });

  const baseInput = {
    queueRow: {
      id: 'q-1',
      account_id: 'tm-adit',
      recipient_email: 'pat@acme.com',
      recipient_name: 'Pat',
      recipient_company: 'Acme',
      template_variant_id: 'v-1',
      send_at: '2026-05-04T12:35:00Z',
      status: 'pending' as const,
    },
    variant: {
      subject_template: 'product prioritization at {{company}}',
      body_template: 'Hi {{first_name}}, ...\nCheers,\n{{founder_name}}',
    },
    founder: {
      id: 'tm-adit',
      name: 'Adit Mittal',
      email: 'aditmittal@berkeley.edu',
    },
    sendMode: 'production' as const,
    allowlist: [] as string[],
  };

  describe('header construction', () => {
    it('builds From with display name + bracketed email', async () => {
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('sent');
      expect(mock.sends).toHaveLength(1);
      expect(mock.sends[0].decoded.from).toContain('"Adit Mittal"');
      expect(mock.sends[0].decoded.from).toContain('<aditmittal@berkeley.edu>');
    });

    it('sets To to the recipient', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.to).toBe('pat@acme.com');
    });

    it('sets Subject to the rendered template', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.subject).toBe('product prioritization at Acme');
    });

    it('sets List-Unsubscribe via plus-aliasing', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.listUnsubscribe).toBe(
        '<mailto:aditmittal+unsubscribe@berkeley.edu?subject=unsubscribe>'
      );
    });

    it('sets List-Unsubscribe-Post for one-click', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.listUnsubscribePost).toBe('List-Unsubscribe=One-Click');
    });

    it('sets Precedence: bulk', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.precedence).toBe('bulk');
    });

    it('sets Content-Type: text/plain; charset=UTF-8', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.contentType).toMatch(/text\/plain.*charset=UTF-8/i);
    });

    it('renders the body with merge tags substituted', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.body).toContain('Hi Pat,');
      expect(mock.sends[0].decoded.body).toContain('Cheers,\nAdit');
    });

    it('does NOT include unsubscribe footer in the body', async () => {
      await sendCampaignEmail(baseInput, mock);
      expect(mock.sends[0].decoded.body).not.toMatch(/unsubscribe|reply STOP|opt[-_ ]?out/i);
    });

    it('emits Reply-To, MIME-Version, X-Priority, Content-Transfer-Encoding in raw MIME', async () => {
      // The mock's structured decoder only surfaces a subset of headers;
      // for the rest we decode the raw payload directly so we get
      // regression protection if any header gets accidentally dropped.
      await sendCampaignEmail(baseInput, mock);
      const decoded = Buffer.from(
        mock.sends[0].raw.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf-8');
      expect(decoded).toMatch(/^Reply-To: aditmittal@berkeley\.edu$/m);
      expect(decoded).toMatch(/^MIME-Version: 1\.0$/m);
      expect(decoded).toMatch(/^X-Priority: 3$/m);
      expect(decoded).toMatch(/^Content-Transfer-Encoding: 7bit$/m);
    });
  });

  describe('founder name extraction', () => {
    it('uses the founder\'s first name for {{founder_name}}', async () => {
      const r = await sendCampaignEmail({
        ...baseInput,
        founder: { id: 'x', name: 'Srijay Vejendla', email: 'srijay@x.edu' },
      }, mock);
      expect(r.outcome).toBe('sent');
      expect(mock.sends[0].decoded.body).toContain('Srijay');
      expect(mock.sends[0].decoded.body).not.toContain('Vejendla');
    });
  });

  describe('send modes', () => {
    it('dry_run skips Gmail call and synthesizes message id', async () => {
      const r = await sendCampaignEmail({ ...baseInput, sendMode: 'dry_run' }, mock);
      expect(r.outcome).toBe('sent');
      if (r.outcome === 'sent') {
        expect(r.gmail_message_id).toBe('dryrun:q-1');
      }
      expect(mock.sends).toHaveLength(0);
    });

    it('allowlist skips non-allowlist recipients', async () => {
      const r = await sendCampaignEmail({
        ...baseInput,
        sendMode: 'allowlist',
        allowlist: ['someone-else@gmail.com'],
      }, mock);
      expect(r.outcome).toBe('skipped');
      if (r.outcome === 'skipped') {
        expect(r.last_error).toBe('not_in_allowlist');
      }
      expect(mock.sends).toHaveLength(0);
    });

    it('allowlist sends to allowlist recipients', async () => {
      const r = await sendCampaignEmail({
        ...baseInput,
        sendMode: 'allowlist',
        allowlist: ['pat@acme.com'],
      }, mock);
      expect(r.outcome).toBe('sent');
      expect(mock.sends).toHaveLength(1);
    });

    it('allowlist match is case-insensitive on email', async () => {
      const r = await sendCampaignEmail({
        ...baseInput,
        sendMode: 'allowlist',
        allowlist: ['PAT@ACME.COM'],
      }, mock);
      expect(r.outcome).toBe('sent');
    });
  });

  describe('error classification', () => {
    it('429 → rate_limit_retry', async () => {
      mock.nextResponse = { error: 429, reason: 'userRateLimitExceeded' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('rate_limit_retry');
    });

    it('403 dailyLimitExceeded → account_pause', async () => {
      mock.nextResponse = { error: 403, reason: 'dailyLimitExceeded' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('account_pause');
      if (r.outcome === 'account_pause') {
        expect(r.reason).toBe('dailyLimitExceeded');
      }
    });

    it('403 quotaExceeded → account_pause', async () => {
      mock.nextResponse = { error: 403, reason: 'quotaExceeded' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('account_pause');
    });

    it('5xx → hard_bounce', async () => {
      mock.nextResponse = { error: 550, reason: 'invalid_recipient' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('hard_bounce');
      if (r.outcome === 'hard_bounce') {
        expect(r.code).toBe(550);
        expect(r.reason).toBe('invalid_recipient');
      }
    });

    it('400 (other 4xx) → soft_bounce', async () => {
      mock.nextResponse = { error: 400, reason: 'invalidArgument' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('soft_bounce');
    });

    it('403 with reason OTHER than dailyLimit/quotaExceeded → soft_bounce, NOT account_pause', async () => {
      // Regression guard: only the two specific reasons trigger pause-the-account.
      // A generic 403 (e.g. permission issue) should be a soft_bounce so the
      // single message fails but the account keeps running.
      mock.nextResponse = { error: 403, reason: 'forbidden' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('soft_bounce');
    });

    it('error with no .code falls through to failed (with traceability)', async () => {
      // Belt-and-suspenders: if Gmail throws something that doesn't fit any
      // bucket, we don't silently misclassify it.
      mock.nextResponse = { error: 0, reason: '' };
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('failed');
      if (r.outcome === 'failed') {
        // last_error should include the queue row id for log traceability
        expect(r.last_error).toContain('q-1');
      }
    });
  });

  describe('successful return shape', () => {
    it('returns gmail_message_id and gmail_thread_id from Gmail response', async () => {
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('sent');
      if (r.outcome === 'sent') {
        expect(r.gmail_message_id).toMatch(/^mock-msg-/);
        expect(r.gmail_thread_id).toMatch(/^mock-thread-/);
      }
    });

    it('exposes the rendered subject + body for downstream CRM logging', async () => {
      // Spec §12.2: interactions.subject/body must be the RENDERED content
      // (post merge-tag + spintax), not the raw templates.
      const r = await sendCampaignEmail(baseInput, mock);
      expect(r.outcome).toBe('sent');
      if (r.outcome === 'sent') {
        expect(r.rendered_subject).toBe('product prioritization at Acme');
        expect(r.rendered_body).toContain('Hi Pat,');
        expect(r.rendered_body).toContain('Cheers,\nAdit');
        expect(r.rendered_body).not.toContain('{{');
      }
    });

    it('exposes rendered output even in dry_run mode', async () => {
      const r = await sendCampaignEmail({ ...baseInput, sendMode: 'dry_run' }, mock);
      expect(r.outcome).toBe('sent');
      if (r.outcome === 'sent') {
        expect(r.gmail_message_id).toBe('dryrun:q-1');
        expect(r.rendered_subject).toBe('product prioritization at Acme');
        expect(r.rendered_body).toContain('Hi Pat,');
      }
    });
  });

  describe('RFC 2822 wire-level invariants', () => {
    it('the raw MIME has a base64url payload (no padding, URL-safe alphabet)', async () => {
      await sendCampaignEmail(baseInput, mock);
      const raw = mock.sends[0].raw;
      // base64url uses - and _ instead of + and /, no padding
      expect(raw).not.toContain('+');
      expect(raw).not.toContain('/');
      expect(raw).not.toContain('=');
    });

    it('header block uses CRLF line endings (RFC 2822)', async () => {
      await sendCampaignEmail(baseInput, mock);
      const decoded = Buffer.from(
        mock.sends[0].raw.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf-8');
      expect(decoded).toContain('\r\n');
    });
  });
});
