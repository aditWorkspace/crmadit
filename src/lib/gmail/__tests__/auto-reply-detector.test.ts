import { describe, it, expect } from 'vitest';
import { detectAutoReply } from '../auto-reply-detector';

const h = (name: string, value: string) => ({ name, value });

describe('detectAutoReply', () => {
  describe('Auto-Submitted (RFC 3834)', () => {
    it('flags auto-replied', () => {
      const v = detectAutoReply([h('Auto-Submitted', 'auto-replied')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) expect(v.reason).toBe('auto_submitted');
    });

    it('flags auto-generated', () => {
      const v = detectAutoReply([h('Auto-Submitted', 'auto-generated')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('does NOT flag explicit "no"', () => {
      const v = detectAutoReply([h('Auto-Submitted', 'no')]);
      expect(v.isAutoReply).toBe(false);
    });

    it('case-insensitive on the value', () => {
      const v = detectAutoReply([h('Auto-Submitted', 'AUTO-REPLIED')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('case-insensitive on the header name', () => {
      const v = detectAutoReply([h('auto-submitted', 'auto-replied')]);
      expect(v.isAutoReply).toBe(true);
    });
  });

  describe('X-Autoreply family', () => {
    it('flags X-Autoreply presence (any value)', () => {
      const v = detectAutoReply([h('X-Autoreply', 'yes')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) expect(v.reason).toBe('x_autoreply');
    });

    it('flags X-Autorespond presence', () => {
      const v = detectAutoReply([h('X-Autorespond', '1')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('flags X-Autoresponder presence', () => {
      const v = detectAutoReply([h('X-Autoresponder', 'true')]);
      expect(v.isAutoReply).toBe(true);
    });
  });

  describe('Precedence', () => {
    it('flags bulk', () => {
      const v = detectAutoReply([h('Precedence', 'bulk')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) expect(v.reason).toBe('precedence_bulk');
    });

    it('flags auto_reply', () => {
      const v = detectAutoReply([h('Precedence', 'auto_reply')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('flags list', () => {
      const v = detectAutoReply([h('Precedence', 'list')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('flags junk', () => {
      const v = detectAutoReply([h('Precedence', 'junk')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('does NOT flag missing precedence', () => {
      const v = detectAutoReply([h('From', 'pat@acme.com')]);
      expect(v.isAutoReply).toBe(false);
    });
  });

  describe('Return-Path', () => {
    it('flags empty <>', () => {
      const v = detectAutoReply([h('Return-Path', '<>')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) expect(v.reason).toBe('empty_return_path');
    });

    it('does NOT flag a real return-path', () => {
      const v = detectAutoReply([h('Return-Path', '<pat@acme.com>')]);
      expect(v.isAutoReply).toBe(false);
    });
  });

  describe('System From-address blocklist', () => {
    it('flags mailer-daemon@', () => {
      const v = detectAutoReply([h('From', 'mailer-daemon@google.com')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) {
        expect(v.reason).toBe('system_from');
        expect(v.detail).toBe('mailer-daemon@google.com');
      }
    });

    it('flags postmaster@', () => {
      const v = detectAutoReply([h('From', 'postmaster@example.com')]);
      expect(v.isAutoReply).toBe(true);
    });

    it('flags noreply / no-reply / do-not-reply / donotreply', () => {
      for (const local of ['noreply', 'no-reply', 'do-not-reply', 'donotreply']) {
        const v = detectAutoReply([h('From', `${local}@example.com`)]);
        expect(v.isAutoReply).toBe(true);
      }
    });

    it('flags display-name + bracketed system address', () => {
      // "Mail Delivery Subsystem <mailer-daemon@google.com>"
      const v = detectAutoReply([h('From', '"Mail Delivery Subsystem" <mailer-daemon@google.com>')]);
      expect(v.isAutoReply).toBe(true);
      if (v.isAutoReply) expect(v.reason).toBe('system_from');
    });

    it('does NOT flag a normal personal address', () => {
      const v = detectAutoReply([h('From', '"Pat Smith" <pat@acme.com>')]);
      expect(v.isAutoReply).toBe(false);
    });
  });

  describe('combined real-world fixtures', () => {
    it('Gmail vacation responder (RFC-correct + filled From)', () => {
      const v = detectAutoReply([
        h('From', '"Pat Smith" <pat@acme.com>'),
        h('Subject', 'Re: product prioritization at Acme'),
        h('Auto-Submitted', 'auto-replied'),
        h('X-Autoreply', 'yes'),
      ]);
      expect(v.isAutoReply).toBe(true);
    });

    it('mailer-daemon NDR with empty return-path', () => {
      const v = detectAutoReply([
        h('From', 'mailer-daemon@gmail.com'),
        h('Return-Path', '<>'),
        h('Subject', 'Delivery Status Notification (Failure)'),
      ]);
      expect(v.isAutoReply).toBe(true);
    });

    it('mailing-list digest', () => {
      const v = detectAutoReply([
        h('From', 'list@example.com'),
        h('Precedence', 'list'),
      ]);
      expect(v.isAutoReply).toBe(true);
    });

    it('genuine human reply with full headers passes through', () => {
      const v = detectAutoReply([
        h('From', '"Pat Smith" <pat@acme.com>'),
        h('To', 'aditmittal@berkeley.edu'),
        h('Subject', 'Re: product prioritization at Acme'),
        h('Date', 'Tue, 28 Apr 2026 10:00:00 +0000'),
        h('Message-Id', '<abc@mail.acme.com>'),
        h('In-Reply-To', '<original@gmail.com>'),
      ]);
      expect(v.isAutoReply).toBe(false);
    });

    it('handles null/empty header arrays gracefully', () => {
      expect(detectAutoReply(null).isAutoReply).toBe(false);
      expect(detectAutoReply(undefined).isAutoReply).toBe(false);
      expect(detectAutoReply([]).isAutoReply).toBe(false);
    });
  });
});
