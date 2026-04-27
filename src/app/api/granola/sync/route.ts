// User-triggered Granola sync. Same engine as the cron, but session-cookie
// auth so it can be hit from the UI Sync button. ?mode=backfill walks the
// whole feed; default is incremental (last-48h lookback).
//
// Note: lives at /api/granola/sync — the action-chat preview-and-confirm
// path uses /api/cron/* to dodge Vercel deployment protection, but a
// session-authenticated UI request goes through the cookie session and
// works fine outside the /api/cron/* prefix.
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { syncAllKeys } from '@/lib/granola/sync';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'backfill' ? 'backfill' : 'incremental';
  const maxNotes = mode === 'backfill' ? 2000 : 200;

  const results = await syncAllKeys({ mode, maxNotes });
  // Compact summary for the UI.
  const summary = {
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
  };
  return NextResponse.json(summary);
}
