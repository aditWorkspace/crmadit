import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callAIMessages } from '../openrouter';

describe('callAIMessages fallback behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(content: string | null) {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }

  function err(status: number, text = 'boom') {
    return {
      ok: false,
      status,
      text: async () => text,
    } as unknown as Response;
  }

  it('retries on empty content using the next fallback model', async () => {
    fetchMock.mockResolvedValueOnce(ok(''));
    fetchMock.mockResolvedValueOnce(ok('the real answer'));

    const out = await callAIMessages({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary/model',
      fallbackModels: ['fallback/model'],
    });

    expect(out).toBe('the real answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx using the next fallback model', async () => {
    fetchMock.mockResolvedValueOnce(err(503));
    fetchMock.mockResolvedValueOnce(ok('recovered'));

    const out = await callAIMessages({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary/model',
      fallbackModels: ['fallback/model'],
    });

    expect(out).toBe('recovered');
  });

  it('does NOT retry on 4xx (bad model id should fail fast)', async () => {
    fetchMock.mockResolvedValueOnce(err(400, 'bad model'));

    await expect(
      callAIMessages({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'primary/model',
        fallbackModels: ['fallback/model'],
      }),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes the failing model slug in the error message', async () => {
    fetchMock.mockResolvedValue(ok(''));

    await expect(
      callAIMessages({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'primary/model',
        fallbackModels: [],
      }),
    ).rejects.toThrow(/primary\/model/);
  });
});
