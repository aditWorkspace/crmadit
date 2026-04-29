import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../render-template';

describe('renderTemplate', () => {
  const baseInput = {
    subject_template: 'product prioritization at {{company}}',
    body_template: 'Hi {{first_name}}, ...\n\nCheers,\n{{founder_name}}',
    first_name: 'Pat',
    company: 'Acme',
    founder_name: 'Adit',
  };

  it('substitutes all three merge tags', () => {
    const r = renderTemplate(baseInput);
    expect(r.subject).toBe('product prioritization at Acme');
    expect(r.body).toContain('Hi Pat,');
    expect(r.body).toContain('Cheers,\nAdit');
  });

  it('falls back to "there" when first_name is null', () => {
    const r = renderTemplate({ ...baseInput, first_name: null });
    expect(r.body).toContain('Hi there,');
  });

  it('falls back to "your company" when company is null', () => {
    const r = renderTemplate({ ...baseInput, company: null });
    expect(r.subject).toBe('product prioritization at your company');
  });

  it('falls back when first_name is empty/whitespace string', () => {
    const r = renderTemplate({ ...baseInput, first_name: '   ' });
    expect(r.body).toContain('Hi there,');
  });

  it('resolves spintax to one of the options uniformly (statistical)', () => {
    const tally = { Hi: 0, Hey: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = renderTemplate({
        ...baseInput,
        body_template: '{{ RANDOM | Hi | Hey }} {{first_name}},',
      });
      if (r.body.startsWith('Hi ')) tally.Hi++;
      else if (r.body.startsWith('Hey ')) tally.Hey++;
    }
    // 50/50 distribution; ±10% tolerance
    expect(tally.Hi).toBeGreaterThan(400);
    expect(tally.Hey).toBeGreaterThan(400);
    expect(tally.Hi + tally.Hey).toBe(1000);
  });

  it('handles spintax with no whitespace around the pipes', () => {
    const r = renderTemplate({ ...baseInput, body_template: '{{RANDOM|Hi|Hey}}' });
    expect(['Hi', 'Hey']).toContain(r.body);
  });

  it('handles spintax with extra inner whitespace', () => {
    const r = renderTemplate({ ...baseInput, body_template: '{{ RANDOM |  Hi  |  Hey  }}' });
    expect(['Hi', 'Hey']).toContain(r.body);
  });

  it('does NOT inject an unsubscribe footer into the body', () => {
    const r = renderTemplate(baseInput);
    expect(r.body).not.toMatch(/unsubscribe|reply STOP|opt[-_ ]?out/i);
  });

  it('html-escapes merge values to prevent injection', () => {
    const r = renderTemplate({
      ...baseInput,
      first_name: 'Pat<script>',
    });
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('Pat&lt;script&gt;');
  });

  it('html-escapes ampersands and quotes too', () => {
    const r = renderTemplate({ ...baseInput, company: 'A & B "Co"' });
    expect(r.subject).toContain('A &amp; B &quot;Co&quot;');
  });

  it('multiple spintax in one template each resolve independently', () => {
    const seenCombos = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = renderTemplate({
        ...baseInput,
        body_template: '{{ RANDOM | A | B }} mid {{ RANDOM | X | Y }}',
      });
      seenCombos.add(r.body);
    }
    // Should see at least 3 of the 4 combinations across 100 rolls
    expect(seenCombos.size).toBeGreaterThanOrEqual(3);
  });

  it('preserves text outside merge tags + spintax verbatim', () => {
    const r = renderTemplate({
      ...baseInput,
      body_template: 'Line 1\nLine 2 {{first_name}} Line 3',
    });
    expect(r.body).toBe('Line 1\nLine 2 Pat Line 3');
  });
});
