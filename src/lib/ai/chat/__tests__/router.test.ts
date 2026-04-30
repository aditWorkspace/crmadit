import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/openrouter', () => ({
  callAI: vi.fn(),
}));

import { callAI } from '@/lib/ai/openrouter';
import { classifyQuestion } from '../router';

const mockedCallAI = vi.mocked(callAI);

describe('classifyQuestion', () => {
  beforeEach(() => {
    mockedCallAI.mockReset();
  });

  it('parses a filter question with explicit N and semantic criterion', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'filter',
        search_terms: ['privacy', 'security', 'data'],
        filter: {
          n: 20,
          ordering: 'recent',
          criterion: 'worried about privacy and wants a security sheet',
          criterion_type: 'semantic',
        },
      }),
    );

    const out = await classifyQuestion(
      'for the last 20 calls, which were worried about privacy?',
    );

    expect(out.kind).toBe('filter');
    if (out.kind !== 'filter') throw new Error('narrowing');
    expect(out.filter.n).toBe(20);
    expect(out.filter.criterion_type).toBe('semantic');
  });

  it('parses a lookup question (no per-call iteration)', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'lookup',
        search_terms: ['Ramp', 'onboarding', 'Alex'],
      }),
    );

    const out = await classifyQuestion(
      'what did Alex at Ramp say about onboarding?',
    );

    expect(out.kind).toBe('lookup');
    if (out.kind === 'lookup') expect(out.search_terms).toContain('Ramp');
  });

  it('parses a scope question', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'scope',
        search_terms: ['Slack', 'integration'],
      }),
    );

    const out = await classifyQuestion(
      'should we cut Slack support from scope?',
    );

    expect(out.kind).toBe('scope');
  });

  it('parses a clarify response', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'clarify',
        clarify_question: 'Do you mean active users or all leads?',
      }),
    );

    const out = await classifyQuestion('which ones are doing well?');

    expect(out.kind).toBe('clarify');
    if (out.kind === 'clarify') {
      expect(out.clarify_question).toMatch(/active users/);
    }
  });

  it('falls back to scope on malformed JSON', async () => {
    mockedCallAI.mockResolvedValue('not json at all {{{');

    const out = await classifyQuestion('something ambiguous');

    expect(out.kind).toBe('scope');
  });

  it('coerces invalid filter payload to lookup (defensive)', async () => {
    mockedCallAI.mockResolvedValue(
      JSON.stringify({
        kind: 'filter',
        search_terms: ['x'],
        // missing filter field — bad model output
      }),
    );

    const out = await classifyQuestion('for last 20, which X');
    // Spec: "Router emits kind='filter' but no filter field → treat as lookup."
    expect(out.kind).toBe('lookup');
  });
});
