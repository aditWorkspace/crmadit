import type { NextConfig } from 'next';

// Minimal standalone site that renders per-recipient landing pages from the
// shared Supabase `landing_pages` table. Deployed as its OWN Vercel project
// with NO deployment protection (the main CRM edge-blocks all public paths).
const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to THIS folder. Without it, building while
  // nested inside the parent CRM repo makes Turbopack infer the parent as root
  // and try to compile the parent's src/proxy.ts (auth gate) — which this public
  // site neither has nor wants. Vercel builds it isolated, but this keeps local
  // builds honest too.
  turbopack: { root: __dirname },

  // PostHog reverse proxy: route analytics through our own domain so ad blockers
  // (which filter by *.posthog.com) can't drop events. Path is intentionally
  // non-obvious (`/cp-relay`, not /ingest|/analytics|/posthog) so blocklists miss
  // it. `beforeFiles` makes these win over the catch-all [slug] route. Trailing
  // slash redirect must be skipped — PostHog's API uses trailing slashes (/e/).
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/cp-relay/static/:path*', destination: 'https://us-assets.i.posthog.com/static/:path*' },
        { source: '/cp-relay/array/:path*', destination: 'https://us-assets.i.posthog.com/array/:path*' },
        { source: '/cp-relay/:path*', destination: 'https://us.i.posthog.com/:path*' },
      ],
    };
  },
};

export default nextConfig;
