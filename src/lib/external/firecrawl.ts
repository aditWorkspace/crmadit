// Thin wrapper for Firecrawl's scrape API (firecrawl.dev). Used by the
// cold-email research engine to pull byte-exact text from a company's own
// pages (changelog / careers / blog / customers) — the strongest possible
// anti-fabrication ground truth, since any evidence card sourced here must
// quote-match the markdown we actually fetched.
//
//   POST https://api.firecrawl.dev/v2/scrape
//     Auth: `Authorization: Bearer <FIRECRAWL_API_KEY>`
//     Body: { url, formats: ['markdown'], onlyMainContent: true }
//     Response: { success: true, data: { markdown, metadata } }
//
// ── Error semantics (critical) ─────────────────────────────────────────────
// The engine distinguishes "this page just isn't there" from "the provider is
// unhealthy". The former is normal and must NOT fail a draft; the latter must
// retry the whole draft (never silently fall through to a generic email).
//
//   return null  → page-level miss: 404, target-site 403, per-request timeout,
//                  success:false, or empty markdown. A missing /changelog is
//                  expected, not an error.
//   throw        → provider-level failure: 401 (bad key), 402 (out of credits),
//                  429 (rate limit), 5xx (server). Surfaced as a typed
//                  FirecrawlError so cold-research.ts maps it to a retry.

import {
  FIRECRAWL_CANDIDATE_PATHS,
  FIRECRAWL_MAX_SCRAPE_ATTEMPTS,
  FIRECRAWL_MAX_SUCCESS_PAGES,
  FIRECRAWL_MAX_TOTAL_MARKDOWN_CHARS,
  FIRECRAWL_SCRAPE_TIMEOUT_MS,
} from '@/lib/email-tool/cold-constants';
import { consumeFirecrawlCredit } from './firecrawl-budget';

const SCRAPE_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';

export type FirecrawlErrorKind = 'auth' | 'quota' | 'rate_limit' | 'server';

export class FirecrawlError extends Error {
  kind: FirecrawlErrorKind;
  status: number;
  constructor(kind: FirecrawlErrorKind, status: number, message: string) {
    super(message);
    this.name = 'FirecrawlError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ScrapedPage {
  url: string;
  markdown: string;
}

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new FirecrawlError('auth', 0, 'FIRECRAWL_API_KEY env var missing');
  return key;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape a single URL → clean markdown, or null on a page-level miss/timeout.
 * Throws FirecrawlError on provider-level failures (auth/quota/rate-limit/5xx).
 */
export async function scrapeUrl(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const key = apiKey();
  // Daily budget gate: once today's Firecrawl credits are spent, skip the paid
  // scrape and behave like a page-level miss so callers use the free fallback.
  if (!(await consumeFirecrawlCredit())) return null;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      SCRAPE_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      },
      opts.timeoutMs ?? FIRECRAWL_SCRAPE_TIMEOUT_MS,
    );
  } catch (err) {
    // AbortError (timeout) or a network blip on a single page — treat as a
    // page-level miss so one slow page doesn't fail the whole draft.
    if (err instanceof Error && err.name === 'AbortError') return null;
    return null;
  }

  if (!res.ok) {
    const status = res.status;
    const body = await res.text().catch(() => '');
    if (status === 401) throw new FirecrawlError('auth', status, `firecrawl auth: ${body.slice(0, 200)}`);
    if (status === 402) throw new FirecrawlError('quota', status, `firecrawl out of credits: ${body.slice(0, 200)}`);
    if (status === 429) throw new FirecrawlError('rate_limit', status, `firecrawl rate limited: ${body.slice(0, 200)}`);
    if (status >= 500) throw new FirecrawlError('server', status, `firecrawl ${status}: ${body.slice(0, 200)}`);
    // 403 (target blocked), 404 (no such page), 408, other 4xx → page-level miss.
    return null;
  }

  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: { markdown?: string } }
    | null;
  if (!data || data.success === false) return null;
  const markdown = data.data?.markdown?.trim();
  return markdown && markdown.length > 0 ? markdown : null;
}

/** Strip protocol / path / leading www down to a bare registrable domain. */
function bareDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d;
}

/**
 * Scrape a capped set of a company's own high-signal pages. Tries the
 * candidate paths in priority order, keeping the first FIRECRAWL_MAX_SUCCESS_
 * PAGES that return content, bounded by an attempt cap and a total-char cap.
 *
 * Provider-level FirecrawlErrors propagate (the engine retries the draft);
 * page-level misses are simply skipped.
 */
export async function scrapeCompanySite(domainOrUrl: string): Promise<ScrapedPage[]> {
  const domain = bareDomain(domainOrUrl);
  if (!domain || !domain.includes('.')) return [];

  const pages: ScrapedPage[] = [];
  let attempts = 0;
  let totalChars = 0;

  for (const path of FIRECRAWL_CANDIDATE_PATHS) {
    if (attempts >= FIRECRAWL_MAX_SCRAPE_ATTEMPTS) break;
    if (pages.length >= FIRECRAWL_MAX_SUCCESS_PAGES) break;
    if (totalChars >= FIRECRAWL_MAX_TOTAL_MARKDOWN_CHARS) break;

    attempts++;
    const url = `https://${domain}${path}`;
    const markdown = await scrapeUrl(url); // FirecrawlError bubbles up by design

    if (!markdown) continue;
    const remaining = FIRECRAWL_MAX_TOTAL_MARKDOWN_CHARS - totalChars;
    const clipped = markdown.length > remaining ? markdown.slice(0, remaining) : markdown;
    pages.push({ url, markdown: clipped });
    totalChars += clipped.length;
  }

  return pages;
}
