import type { NextConfig } from 'next';

// Minimal standalone site that renders per-recipient landing pages from the
// shared Supabase `landing_pages` table. Deployed as its OWN Vercel project
// with NO deployment protection (the main CRM edge-blocks all public paths).
const nextConfig: NextConfig = {};

export default nextConfig;
