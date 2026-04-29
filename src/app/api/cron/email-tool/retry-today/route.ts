// Admin endpoint: retry today's campaign if it was aborted (e.g., by the
// orphan-recovery sweep after a partial-start failure). Generates a manual
// idempotency_key so we don't collide with the original aborted campaign's
// claim. See spec §6 step ⓪ + §11.7 "Retry today's run" button.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { runDailyStart } from '@/lib/email-tool/start';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const now = new Date();

  // Compute today's PT date for the existence check
  const todayPtKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  // Today's existing campaign — must be 'aborted' for retry to be allowed.
  // Anything else (running/done/skipped/exhausted/paused/pending) is a
  // valid state we shouldn't disturb.
  const { data: existing } = await supabase
    .from('email_send_campaigns')
    .select('id, status')
    .eq('idempotency_key', todayPtKey)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({
      error: 'no campaign for today exists; nothing to retry',
    }, { status: 409 });
  }

  const status = (existing as { status: string }).status;
  if (status !== 'aborted') {
    return NextResponse.json({
      error: `today's campaign is in status='${status}'; only 'aborted' campaigns can be retried`,
    }, { status: 409 });
  }

  // Generate a manual idempotency_key that won't collide with the aborted
  // campaign's key. Format: 'manual-YYYY-MM-DD-<unix_ms>'.
  const manualKey = `manual-${todayPtKey}-${now.getTime()}`;
  const result = await runDailyStart(supabase, {
    now,
    idempotencyKey: manualKey,
  });

  return NextResponse.json({ ok: true, manual_idempotency_key: manualKey, result });
}
