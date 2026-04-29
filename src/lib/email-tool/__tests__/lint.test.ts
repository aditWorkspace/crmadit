import { describe, it, expect } from 'vitest';
import { lintTemplate } from '../lint';

describe('lintTemplate', () => {
  const valid = {
    subject_template: 'product prioritization at {{company}}',
    body_template: 'Hi {{first_name}}, I like {{company}}. Thanks,\n{{founder_name}}',
  };

  describe('blockers', () => {
    it('passes a valid variant with no blockers', () => {
      const r = lintTemplate(valid);
      expect(r.blockers).toEqual([]);
    });

    it('blocks bit.ly in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nbit.ly/foo' });
      expect(r.blockers.some(b => b.code === 'url_shortener')).toBe(true);
    });

    it('blocks tinyurl in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nhttps://tinyurl.com/abc' });
      expect(r.blockers.some(b => b.code === 'url_shortener')).toBe(true);
    });

    it('blocks t.co in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + ' t.co/x' });
      expect(r.blockers.some(b => b.code === 'url_shortener')).toBe(true);
    });

    it('blocks if author types "unsubscribe" in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nclick here to unsubscribe' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('blocks if author types literal "STOP" word in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nreply STOP to stop' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('blocks if author types "opt-out" in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nyou can opt-out anytime' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('blocks subject containing noreply', () => {
      const r = lintTemplate({ ...valid, subject_template: 'noreply test' });
      expect(r.blockers.some(b => b.code === 'subject_noreply')).toBe(true);
    });

    it('blocks subject containing do-not-reply', () => {
      const r = lintTemplate({ ...valid, subject_template: 'do-not-reply important' });
      expect(r.blockers.some(b => b.code === 'subject_noreply')).toBe(true);
    });

    it('blocks body shorter than 30 chars', () => {
      const r = lintTemplate({ ...valid, body_template: 'Hi.' });
      expect(r.blockers.some(b => b.code === 'body_too_short')).toBe(true);
    });

    it('blocks body longer than 800 chars', () => {
      const r = lintTemplate({ ...valid, body_template: 'a'.repeat(801) });
      expect(r.blockers.some(b => b.code === 'body_too_long')).toBe(true);
    });

    it('multiple blockers stack — one body can produce many blockers', () => {
      const r = lintTemplate({
        subject_template: 'noreply important',
        body_template: 'Hi. unsubscribe via bit.ly/x',  // 30 chars-ish but contains bit.ly + unsubscribe
      });
      // subject_noreply + url_shortener + forbidden_word_unsubscribe = 3 blockers
      // body_too_short may or may not trigger depending on exact length — don't depend on it
      expect(r.blockers.map(b => b.code)).toEqual(
        expect.arrayContaining(['subject_noreply', 'url_shortener', 'forbidden_word_unsubscribe'])
      );
    });

    it('blocks capitalized "Unsubscribe" (regression)', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nUnsubscribe link below.' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('blocks ALL-CAPS "UNSUBSCRIBE"', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nUNSUBSCRIBE NOW' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('blocks "Opt-Out" with mixed case', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nclick here to Opt-Out' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
    });

    it('does NOT block lowercase "stop" inside another word (e.g. "stopwatch")', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + ' use a stopwatch to time' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(false);
    });

    it('does NOT block lowercase "stop" as a standalone English word', () => {
      // "STOP" capitalized is the spam pattern; lowercase "stop" in normal prose is fine.
      const r = lintTemplate({ ...valid, body_template: valid.body_template + ' please stop reading' });
      expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(false);
    });

    it('does NOT block exactly-30-char body (boundary)', () => {
      const body = 'a'.repeat(30); // exactly 30 chars after trim
      const r = lintTemplate({ ...valid, body_template: body });
      expect(r.blockers.some(b => b.code === 'body_too_short')).toBe(false);
    });

    it('does NOT block exactly-800-char body (boundary)', () => {
      const body = 'a'.repeat(800);
      const r = lintTemplate({ ...valid, body_template: body });
      expect(r.blockers.some(b => b.code === 'body_too_long')).toBe(false);
    });
  });

  describe('warnings', () => {
    it('warns when body lacks both {{first_name}} and {{company}}', () => {
      const r = lintTemplate({
        subject_template: 'hello there',
        body_template: 'Hi there, hope you are well. Thanks, me.',
      });
      expect(r.warnings.some(w => w.code === 'no_personalization')).toBe(true);
    });

    it('does NOT warn when only one of {{first_name}} or {{company}} is used', () => {
      const r1 = lintTemplate({
        subject_template: 'hello',
        body_template: 'Hi {{first_name}}, hope you are well. Thanks, me.',
      });
      expect(r1.warnings.some(w => w.code === 'no_personalization')).toBe(false);
      const r2 = lintTemplate({
        subject_template: 'hello',
        body_template: 'Hi there at {{company}}, hope you are well. Thanks.',
      });
      expect(r2.warnings.some(w => w.code === 'no_personalization')).toBe(false);
    });

    it('warns on spammy "free" in body', () => {
      const r = lintTemplate({ ...valid, body_template: valid.body_template + ' free trial' });
      expect(r.warnings.some(w => w.code === 'spammy_words')).toBe(true);
    });

    it('warns on spammy words in subject too', () => {
      const r = lintTemplate({ ...valid, subject_template: 'act now {{company}}' });
      expect(r.warnings.some(w => w.code === 'spammy_words')).toBe(true);
    });

    it('warns on subject longer than 80 chars', () => {
      const r = lintTemplate({
        ...valid,
        subject_template: 'a'.repeat(85) + ' {{company}}',
      });
      expect(r.warnings.some(w => w.code === 'subject_too_long')).toBe(true);
    });

    it('warns on subject with run of 6+ caps', () => {
      const r = lintTemplate({ ...valid, subject_template: 'URGENT please respond' });
      expect(r.warnings.some(w => w.code === 'subject_caps')).toBe(true);
    });

    it('does NOT warn on subject with 5-char caps run (under threshold)', () => {
      const r = lintTemplate({ ...valid, subject_template: 'HELLO {{company}}' });
      expect(r.warnings.some(w => w.code === 'subject_caps')).toBe(false);
    });

    it('warns on >2 links in body', () => {
      const r = lintTemplate({
        ...valid,
        body_template: valid.body_template + ' https://a.com https://b.com https://c.com',
      });
      expect(r.warnings.some(w => w.code === 'too_many_links')).toBe(true);
    });

    it('does NOT warn on exactly 2 links', () => {
      const r = lintTemplate({
        ...valid,
        body_template: valid.body_template + ' https://a.com https://b.com',
      });
      expect(r.warnings.some(w => w.code === 'too_many_links')).toBe(false);
    });

    it('no_personalization is a warning, NOT a blocker (regression)', () => {
      const r = lintTemplate({
        subject_template: 'hello there',
        body_template: 'Hi there, hope you are well. Long enough body. Thanks.',
      });
      expect(r.blockers.find(b => b.code === 'no_personalization')).toBeUndefined();
      expect(r.warnings.find(w => w.code === 'no_personalization')).toBeDefined();
    });

    it('does NOT warn on exactly-80-char subject (boundary)', () => {
      const subject = 'a'.repeat(80);
      const r = lintTemplate({ ...valid, subject_template: subject });
      expect(r.warnings.some(w => w.code === 'subject_too_long')).toBe(false);
    });
  });

  describe('result shape', () => {
    it('returns { blockers: [], warnings: [] } for a perfectly valid input', () => {
      const r = lintTemplate(valid);
      expect(r).toHaveProperty('blockers');
      expect(r).toHaveProperty('warnings');
      expect(Array.isArray(r.blockers)).toBe(true);
      expect(Array.isArray(r.warnings)).toBe(true);
    });

    it('each issue has code, severity, and message', () => {
      const r = lintTemplate({ ...valid, body_template: 'Hi.' });
      const b = r.blockers[0];
      expect(b).toHaveProperty('code');
      expect(b).toHaveProperty('severity');
      expect(b).toHaveProperty('message');
      expect(b.severity).toBe('blocker');
      expect(typeof b.message).toBe('string');
      expect(b.message.length).toBeGreaterThan(0);
    });
  });
});
