// One-shot Granola backfill. Walks the entire /v1/notes feed for both keys,
// matches every note against active leads, imports anything that lands a
// strong/medium match. Personal meetings (no matching lead) are skipped.
//
// Lives under /api/cron/* because Vercel intercepts other paths under
// project-level Deployment Protection — the /api/cron/* prefix is exempt
// (the existing email-sync, daily-digest, etc. routes work the same way).
//
// Auth: requires CRON_SECRET. Run via:
//   curl -X POST https://pmcrminternal.vercel.app/api/cron/granola-backfill \
//        -H "Authorization: Bearer $CRON_SECRET"
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronAuth } from '@/lib/auth/cron';
import { syncAllKeys } from '@/lib/granola/sync';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Backfill mode ignores last_synced_at and walks the whole feed.
  // maxNotes=2000 is generous; even at the API rate limit (~5 req/s) one
  // Vercel function run can comfortably do this within 300s maxDuration.
  const results = await syncAllKeys({ mode: 'backfill', maxNotes: 2000 });
  return NextResponse.json({ ok: true, results });
}

export { handler as GET, handler as POST };
