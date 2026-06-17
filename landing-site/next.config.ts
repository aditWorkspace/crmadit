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
};

export default nextConfig;
