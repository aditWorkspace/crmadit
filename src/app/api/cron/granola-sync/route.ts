// Granola sync cron — pulls notes created since last_synced_at for each
// API key, matches them to leads, and imports new transcripts. Designed to
// run every 30 min so notes finished ~1h ago land in the CRM automatically.
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronAuth } from '@/lib/auth/cron';
import { syncAllKeys } from '@/lib/granola/sync';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await syncAllKeys({ mode: 'incremental', maxNotes: 200 });
  return NextResponse.json({ ok: true, results });
}

export { handler as GET, handler as POST };
