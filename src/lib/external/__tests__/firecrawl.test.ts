import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scrapeUrl, scrapeCompanySite, FirecrawlError } from '../firecrawl';
import { FIRECRAWL_MAX_SUCCESS_PAGES } from '@/lib/email-tool/cold-constants';

function res(status: number, jsonBody: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    json: async () => jsonBody,
  } as unknown as Response;
}

describe('firecrawl scrapeUrl', () => {
  beforeEach(() => { process.env.FIRECRAWL_API_KEY = 'test-key'; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns markdown on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: { markdown: 'hello world' } })));
    expect(await scrapeUrl('https://x.com')).toBe('hello world');
  });

  it('returns null on success:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: false })));
    expect(await scrapeUrl('https://x.com')).toBeNull();
  });

  it('returns null on 404 / 403 (page-level miss)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404, {})));
    expect(await scrapeUrl('https://x.com')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => res(403, {})));
    expect(await scrapeUrl('https://x.com')).toBeNull();
  });

  it('returns null on timeout (AbortError)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    expect(await scrapeUrl('https://x.com')).toBeNull();
  });

  it.each([
    [401, 'auth'],
    [402, 'quota'],
    [429, 'rate_limit'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('throws typed FirecrawlError on %i', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => res(status, {})));
    await expect(scrapeUrl('https://x.com')).rejects.toMatchObject({ name: 'FirecrawlError', kind });
  });

  it('throws if the API key is missing', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(scrapeUrl('https://x.com')).rejects.toBeInstanceOf(FirecrawlError);
  });
});

describe('firecrawl scrapeCompanySite', () => {
  beforeEach(() => { process.env.FIRECRAWL_API_KEY = 'test-key'; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('caps at MAX_SUCCESS_PAGES even if every page returns content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: { markdown: 'page content here' } })));
    const pages = await scrapeCompanySite('example.com');
    expect(pages.length).toBe(FIRECRAWL_MAX_SUCCESS_PAGES);
  });

  it('propagates a provider error (so the engine can retry)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(429, {})));
    await expect(scrapeCompanySite('example.com')).rejects.toBeInstanceOf(FirecrawlError);
  });

  it('returns empty for a non-domain input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: { markdown: 'x' } })));
    expect(await scrapeCompanySite('not-a-domain')).toEqual([]);
  });
});
