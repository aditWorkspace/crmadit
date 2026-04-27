// User-triggered Granola sync. Same engine as /api/cron/granola-sync but
// session-cookie auth, hit from the UI Sync button. ?mode=backfill walks
// the entire feed; default is incremental (last-48h lookback).
//
// Lives under /api/cron/* because Vercel's deployment-protection layer
// HTML-404s authenticated POSTs to other /api/* paths. The /api/cron/*
// prefix is exempt (same as granola-backfill, granola-sync).
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { syncAllKeys } from '@/lib/granola/sync';

async function handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'backfill' ? 'backfill' : 'incremental';
  const maxNotes = mode === 'backfill' ? 2000 : 200;

  const results = await syncAllKeys({ mode, maxNotes });
  return NextResponse.json({
    mode,
    by_key: results.map(r => ({
      label: r.api_key_label,
      scanned: r.scanned,
      imported: r.imported,
      dup: r.skipped_dup,
      no_match: r.skipped_no_match,
      low_confidence: r.skipped_low_confidence,
      errors: r.errors,
      imported_log: r.match_log
        .filter(l => l.decision === 'imported')
        .map(l => ({ note_id: l.note_id, lead: l.lead, reason: l.reason, confidence: l.confidence })),
    })),
    total_imported: results.reduce((a, r) => a + r.imported, 0),
  });
}

export { handler as POST };
