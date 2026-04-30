import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

// Stale threshold: cron runs every 30 min, so anything older than 2h means
// the cron has missed >3 runs in a row — worth surfacing.
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export interface GranolaKeyStatus {
  label: string;                 // 'adit' | 'srijay'
  last_run_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  notes_imported: number | null;
  notes_skipped: number | null;
  healthy: boolean;              // false if last_error or last_run_at >2h old
  reason: string | null;         // human-readable summary when not healthy
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('granola_sync_state')
    .select('api_key_label, last_run_at, last_synced_at, last_error, notes_imported, notes_skipped')
    .order('api_key_label', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  const keys: GranolaKeyStatus[] = (data || []).map(row => {
    const lastRunMs = row.last_run_at ? new Date(row.last_run_at).getTime() : null;
    const isStale = !lastRunMs || (now - lastRunMs) > STALE_THRESHOLD_MS;
    const hasError = !!row.last_error;
    const healthy = !hasError && !isStale;
    let reason: string | null = null;
    if (hasError) reason = `last error: ${row.last_error}`;
    else if (isStale) reason = `no successful run for ${lastRunMs ? Math.round((now - lastRunMs) / 60000) + 'm' : 'never'} (cron may be down)`;
    return {
      label: row.api_key_label,
      last_run_at: row.last_run_at,
      last_synced_at: row.last_synced_at,
      last_error: row.last_error,
      notes_imported: row.notes_imported,
      notes_skipped: row.notes_skipped,
      healthy,
      reason,
    };
  });

  return NextResponse.json({ keys });
}
