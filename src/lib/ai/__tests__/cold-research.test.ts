import { describe, it, expect } from 'vitest';
import {
  deriveDomain,
  scrubCopy,
  quoteAppearsIn,
  isSensitiveEvidence,
  verifyEvidence,
  selectAndScore,
  processDraftRow,
  type DraftInput,
} from '../cold-research';
import { FirecrawlError } from '@/lib/external/firecrawl';
import type { EvidenceCard, EvidenceKind } from '@/lib/validation';

function card(p: Partial<EvidenceCard> & { id: string; kind: EvidenceKind; statement: string; source_type: EvidenceCard['source_type'] }): EvidenceCard {
  return {
    evidence_quote: null, source_url: null, confidence: 0.5,
    usable_in_email: false, supporting_only: false, reject_reason: null, ...p,
  };
}

describe('pure helpers', () => {
  it('deriveDomain prefers explicit domain, falls back to email host', () => {
    expect(deriveDomain({ domain: 'acme.com', email: 'x@other.com' })).toBe('acme.com');
    expect(deriveDomain({ domain: null, email: 'x@acme.io' })).toBe('acme.io');
    expect(deriveDomain({ domain: '', email: 'x@ACME.IO' })).toBe('acme.io');
  });

  it('scrubCopy replaces dashes and strips stray merge tags', () => {
    expect(scrubCopy('we ship fast — really')).toBe('we ship fast, really');
    expect(scrubCopy('hi {{first_name}} there')).toBe('hi there');
    expect(scrubCopy('a – b')).toBe('a, b');
  });

  it('quoteAppearsIn matches normalized substrings, rejects short/absent quotes', () => {
    const hay = 'Changelog: We shipped Billing v2 last week to all customers.';
    expect(quoteAppearsIn('We shipped billing v2 last week', hay)).toBe(true);
    expect(quoteAppearsIn('we never said this at all here', hay)).toBe(false);
    expect(quoteAppearsIn('hi', hay)).toBe(false);
  });

  it('isSensitiveEvidence flags personal-life content, allows business facts', () => {
    expect(isSensitiveEvidence(card({ id: '1', kind: 'person_post', statement: 'he just got married', source_type: 'sonar' }))).toBe(true);
    expect(isSensitiveEvidence(card({ id: '2', kind: 'company_hiring', statement: 'hiring a support lead', source_type: 'sonar' }))).toBe(false);
  });

  it("isSensitiveEvidence does not flag a company's own name (e.g. The Family)", () => {
    const c = card({ id: '1', kind: 'company_customer_story', statement: 'The Family holds shares in 120 startups', source_type: 'sonar' });
    expect(isSensitiveEvidence(c)).toBe(true);                 // bare "family" trips the filter
    expect(isSensitiveEvidence(c, 'The Family')).toBe(false);  // company name excluded
  });
});

describe('verifyEvidence', () => {
  it('keeps a firecrawl card whose quote is in the scrape', () => {
    const md = 'We shipped billing v2 last week to customers.';
    const [c] = verifyEvidence(
      [card({ id: 'a', kind: 'company_changelog', statement: 'shipped billing v2', source_type: 'firecrawl', source_url: 'https://acme.com/changelog', evidence_quote: 'We shipped billing v2 last week' })],
      md,
    );
    expect(c.usable_in_email).toBe(true);
  });

  it('drops a firecrawl card whose quote is not in the scrape', () => {
    const [c] = verifyEvidence(
      [card({ id: 'a', kind: 'company_changelog', statement: 'x', source_type: 'firecrawl', source_url: 'https://acme.com/changelog', evidence_quote: 'a quote that does not appear anywhere' })],
      'unrelated page text',
    );
    expect(c.usable_in_email).toBe(false);
    expect(c.reject_reason).toBe('not_in_scrape');
  });

  it('drops cards with no source url, and sensitive cards, and model role_based', () => {
    const out = verifyEvidence([
      card({ id: 'a', kind: 'person_quote', statement: 'said something', source_type: 'sonar', evidence_quote: 'said something specific here', confidence: 0.9 }),
      card({ id: 'b', kind: 'person_post', statement: 'his wife runs marketing', source_type: 'sonar', source_url: 'https://x.com', evidence_quote: 'his wife runs marketing now', confidence: 0.9 }),
      card({ id: 'c', kind: 'role_based', statement: 'generic pain', source_type: 'derived' }),
    ], '');
    expect(out.find(c => c.id === 'a')!.reject_reason).toBe('no_source');
    expect(out.find(c => c.id === 'b')!.reject_reason).toBe('sensitive');
    expect(out.find(c => c.id === 'c')!.reject_reason).toBe('model_role_based_ignored');
  });

  it('trusts a cited sonar card with sufficient confidence, drops low-confidence', () => {
    const [usable] = verifyEvidence(
      [card({ id: 'a', kind: 'company_hiring', statement: 'hiring a PM', source_type: 'sonar', source_url: 'https://jobs.lever.co/acme/pm', evidence_quote: 'Product Manager, full time', confidence: 0.8 })],
      '',
    );
    expect(usable.usable_in_email).toBe(true);

    const [dropped] = verifyEvidence(
      [card({ id: 'a', kind: 'company_hiring', statement: 'maybe hiring', source_type: 'sonar', source_url: 'https://jobs.lever.co/acme/pm', evidence_quote: 'Product Manager, full time', confidence: 0.2 })],
      '',
    );
    expect(dropped.usable_in_email).toBe(false);
    expect(dropped.reject_reason).toBe('low_confidence');
  });

  it('marks a cited public_complaint as supporting-only', () => {
    const [c] = verifyEvidence(
      [card({ id: 'a', kind: 'public_complaint', statement: 'support is slow', source_type: 'sonar', source_url: 'https://reddit.com/x', evidence_quote: 'support is slow and tickets get lost', confidence: 0.7 })],
      '',
    );
    expect(c.usable_in_email).toBe(true);
    expect(c.supporting_only).toBe(true);
  });
});

describe('selectAndScore (tier + score in code)', () => {
  const usable = (kind: EvidenceKind, id = kind): EvidenceCard =>
    card({ id, kind, statement: kind, source_type: 'firecrawl', usable_in_email: true, supporting_only: kind === 'public_complaint' });

  it('picks the strongest (lowest) tier among usable openers', () => {
    const r = selectAndScore([usable('company_hiring'), usable('person_quote')]);
    expect(r.tier).toBe(1);
    expect(r.score).toBe(95);
    expect(r.cards.length).toBeGreaterThan(0);
  });

  it('scores a hiring-only opener at tier 3', () => {
    const r = selectAndScore([usable('company_hiring')]);
    expect(r.tier).toBe(3);
    expect(r.score).toBe(65);
  });

  it('falls back to tier 6 with no cards when only a complaint survives', () => {
    const r = selectAndScore([usable('public_complaint')]);
    expect(r.tier).toBe(6);
    expect(r.score).toBe(20);
    expect(r.cards).toEqual([]);
  });

  it('falls back to tier 6 when nothing is usable', () => {
    expect(selectAndScore([]).tier).toBe(6);
  });
});

// ── Engine-level: provider failure → retry (NOT a silent tier-6) ───────────

interface FakeResult { data: unknown; error: unknown }
function makeBuilder(result: FakeResult) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'ilike', 'eq', 'is', 'or', 'order', 'limit', 'update', 'upsert', 'insert', 'gte', 'lte', 'in']) {
    b[m] = () => b;
  }
  b.maybeSingle = async () => result;
  b.single = async () => result;
  b.then = (resolve: (v: FakeResult) => unknown) => resolve(result);
  return b;
}
function makeSupa(byTable: Record<string, FakeResult> = {}) {
  return { from: (t: string) => makeBuilder(byTable[t] ?? { data: null, error: null }) } as never;
}

const baseInput: DraftInput = {
  id: 'd1', pool_id: 'p1', email: 'pat@acme.com', first_name: 'Pat', full_name: 'Pat Lee',
  company: 'Acme', domain: 'acme.com', sender_account_id: 's1', sender_name: 'Adit Mittal', sender_email: 'adit@x.com',
};

describe('processDraftRow outcome semantics', () => {
  it('skips a lead that is already in the CRM (no spend)', async () => {
    const supa = makeSupa({ leads: { data: { id: 'L1' }, error: null } });
    const out = await processDraftRow(baseInput, supa, {});
    expect(out.kind).toBe('skipped');
    if (out.kind === 'skipped') expect(out.reason).toBe('already_crm_lead');
  });

  it('maps a Firecrawl provider failure to retry, never tier-6', async () => {
    const supa = makeSupa(); // leads/blacklist/cache all null → proceeds to scrape
    const out = await processDraftRow(baseInput, supa, {
      scrapeCompanySiteFn: async () => { throw new FirecrawlError('rate_limit', 429, 'slow down'); },
    });
    expect(out.kind).toBe('retry');
  });

  it('maps a Sonar 5xx to retry', async () => {
    const supa = makeSupa();
    const out = await processDraftRow(baseInput, supa, {
      scrapeCompanySiteFn: async () => [],
      runSonarFn: async () => { throw new Error('Perplexity API error 503: down'); },
    });
    expect(out.kind).toBe('retry');
  });
});
