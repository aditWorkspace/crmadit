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
    // Diagnostic-only: tells us WHICH part of the auth failed without
    // leaking secret content. Safe because the response is a 401 —
    // attacker already knows auth failed.
    const auth = req.headers.get('authorization');
    const xCron = req.headers.get('x-cron-secret');
    const expectedLen = (process.env.CRON_SECRET || '').length;
    return NextResponse.json({
      error: 'Unauthorized',
      diag: {
        has_auth_header: !!auth,
        auth_prefix: auth ? auth.slice(0, 7) : null,
        auth_len: auth?.length ?? 0,
        has_x_cron: !!xCron,
        x_cron_len: xCron?.length ?? 0,
        env_cron_secret_len: expectedLen,
      },
    }, { status: 401 });
  }

  const results = await syncAllKeys({ mode: 'backfill', maxNotes: 2000 });
  return NextResponse.json({ ok: true, results });
}
