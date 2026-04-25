// One-shot Granola backfill. Walks the entire /v1/notes feed for both keys,
// matches every note against active leads, imports anything that lands a
// strong/medium match. Personal meetings (no matching lead) are skipped.
//
// Auth: requires CRON_SECRET (same as cron routes). Run via:
//   curl -X POST https://pmcrminternal.vercel.app/api/granola/backfill \
//        -H "Authorization: Bearer $CRON_SECRET"
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronAuth } from '@/lib/auth/cron';
import { syncAllKeys } from '@/lib/granola/sync';

export async function POST(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Backfill mode ignores last_synced_at and walks the whole feed.
  // maxNotes=2000 is generous; under-budget for one Vercel function run
  // even with 5 req/s rate limit (~6 minutes for 2000 notes worst case).
  const results = await syncAllKeys({ mode: 'backfill', maxNotes: 2000 });
  return NextResponse.json({ ok: true, results });
}
