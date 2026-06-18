'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';
import { useEffect } from 'react';

// Client-side PostHog init for the calproduct landing pages. Captures pageviews
// + pageleaves + autocaptured clicks (e.g. the "Book a 30 min chat" CTA).
// PostHog project key is a PUBLIC, write-only client key (it ships in the
// browser bundle regardless, like a GA measurement ID) — hardcoded as a fallback
// so prod works even without the env var; an env var still overrides it.
const POSTHOG_KEY = 'phc_kqenxtDXiJD9L8wraDXbhEZafonDeUBhQFG7YDSZYaY6';
let inited = false;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY || POSTHOG_KEY;
    if (!key || inited) return;
    inited = true;
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      ui_host: 'https://us.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      person_profiles: 'identified_only',
    });
  }, []);
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
