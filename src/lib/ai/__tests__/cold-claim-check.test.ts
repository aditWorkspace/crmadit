import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/openrouter', () => ({ callAIMessages: vi.fn() }));

import { callAIMessages } from '@/lib/ai/openrouter';
import { claimCheck } from '../cold-claim-check';

const mockCallAI = vi.mocked(callAIMessages);

describe('claimCheck', () => {
  beforeEach(() => mockCallAI.mockReset());

  it('passes when every recipient claim maps to evidence', async () => {
    mockCallAI.mockResolvedValue(JSON.stringify({
      claims: [
        { text: 'proxi ships issues to linear', type: 'proxi_claim', supported: true, evidence_id: null },
        { text: 'you shipped billing v2', type: 'recipient_company_person_claim', supported: true, evidence_id: 'c1' },
        { text: 'worth 15 minutes?', type: 'cta_opinion', supported: true, evidence_id: null },
      ],
    }));
    const r = await claimCheck({ subject: 's', body: 'b', cards: [] });
    expect(r.ok).toBe(true);
    expect(r.unsupportedClaims).toEqual([]);
  });

  it('fails when a recipient claim is unsupported', async () => {
    mockCallAI.mockResolvedValue(JSON.stringify({
      claims: [
        { text: 'you just raised a series b', type: 'recipient_company_person_claim', supported: false, evidence_id: null },
      ],
    }));
    const r = await claimCheck({ subject: 's', body: 'b', cards: [] });
    expect(r.ok).toBe(false);
    expect(r.unsupportedClaims).toContain('you just raised a series b');
  });

  it('fails closed on unparseable auditor output', async () => {
    mockCallAI.mockResolvedValue('not json at all');
    const r = await claimCheck({ subject: 's', body: 'b', cards: [] });
    expect(r.ok).toBe(false);
    expect(r.unsupportedClaims).toEqual(['claim_check_unparseable']);
  });
  // Note: provider-error propagation (callAI throws → engine maps to retry) is
  // covered at the engine level in cold-research.test.ts ('maps a Sonar 5xx to
  // retry'), which exercises the same uncaught-error path end to end.
});
