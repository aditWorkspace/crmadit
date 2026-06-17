import { describe, it, expect } from 'vitest';
import { lintColdEmail } from '../cold-lint';

// A clean, rule-abiding email used as the positive control.
const GOOD_SUBJECT = 'intercom into linear';
const GOOD_BODY = `Hi Pat, saw you shipped the new billing dashboard last week and figured customer feedback is piling up faster than one team can sort. Proxi sits on top of your customer data, pulls signal from support and sales calls, ties each one to the account, weights it by that account revenue, and files the top patterns into Linear with the original quote attached. So you build what your biggest accounts actually ask for. worth 15 minutes to see if it fits? Best, Adit`;

function codes(subject: string, body: string): string[] {
  return lintColdEmail(subject, body).issues.filter(i => i.severity === 'blocker').map(i => i.code);
}

describe('lintColdEmail', () => {
  it('passes a clean email', () => {
    const r = lintColdEmail(GOOD_SUBJECT, GOOD_BODY);
    expect(r.ok).toBe(true);
    expect(r.issues.filter(i => i.severity === 'blocker')).toHaveLength(0);
  });

  it('blocks em/en dashes', () => {
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('last week and', 'last week — and'))).toContain('dashes');
  });

  it('blocks merge tags', () => {
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('Hi Pat', 'Hi {{first_name}}'))).toContain('merge_tags');
  });

  it('blocks URLs and bare domains', () => {
    expect(codes(GOOD_SUBJECT, `${GOOD_BODY} see proxitest.com`)).toContain('urls');
    expect(codes(GOOD_SUBJECT, `${GOOD_BODY} https://x.io`)).toContain('urls');
  });

  it('blocks emoji', () => {
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('Best,', 'Best 🚀,'))).toContain('emoji');
  });

  it('blocks a deceptive re:/fwd: subject', () => {
    expect(codes('re: our chat', GOOD_BODY)).toContain('deceptive_subject');
  });

  it('blocks an uppercase subject', () => {
    expect(codes('Intercom Into Linear', GOOD_BODY)).toContain('subject_not_lowercase');
  });

  it('blocks a subject of 8+ words', () => {
    expect(codes('saw the customer ops role posting today and tomorrow', GOOD_BODY)).toContain('subject_too_long');
  });

  it('blocks corporate-cliché / hype phrases', () => {
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('saw you shipped', "let's touch base, saw you shipped"))).toContain('forbidden_phrase');
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('files the top patterns', 'will seamlessly unlock and files the top patterns'))).toContain('forbidden_phrase');
  });

  it('blocks AI-tell constructions and jargon (that kind of / genuinely / customer signal)', () => {
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('So you build', 'That kind of growth means you build'))).toContain('forbidden_phrase');
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('worth 15 minutes', "I'd genuinely love 15 minutes"))).toContain('forbidden_phrase');
    expect(codes(GOOD_SUBJECT, GOOD_BODY.replace('customer feedback', 'customer signal'))).toContain('forbidden_phrase');
  });

  it('allows a warm human greeting (hope you are doing well / reach out)', () => {
    const body = `Hey Daniel,\n\nHope you're doing well. I read your blog about bridging design and development. I wanted to reach out because I'm currently building something in the product feedback space and would love to hear how you think about deciding what to build. I was wondering if you had 15 to 20 minutes later this week to chat? Adit`;
    expect(lintColdEmail('the design dev gap', body).ok).toBe(true);
  });

  it('blocks bodies that are too short or too long', () => {
    expect(codes(GOOD_SUBJECT, 'too short')).toContain('body_too_short');
    expect(codes(GOOD_SUBJECT, GOOD_BODY + ' ' + 'word '.repeat(120))).toContain('body_too_long');
  });
});
