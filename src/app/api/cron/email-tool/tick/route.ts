// Vercel cron entry point. Fires every minute (configured in vercel.json).
// Wraps runTick in try/catch with crash + timeout signal writes per
// spec §11.4. If 3+ crashes occur in CRASH_COUNTER_WINDOW_MINUTES (10),
// pauses all founders and writes an alert.

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runTick } from '@/lib/email-tool/tick';
import { SAFETY_LIMITS } from '@/lib/email-tool/safety-limits';
import { log } from '@/lib/email-tool/log';

export const maxDuration = 300; // Vercel's per-function cap; tick budget is 240s

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = createAdminClient();

  try {
    const stats = await runTick(supabase);
    const elapsedMs = Date.now() - startedAt;

    // C10: timeout signal — log if we ran past the safe budget
    const budgetMs = SAFETY_LIMITS.TICK_BUDGET_DURATION_SECONDS * 1000;
    if (elapsedMs > budgetMs - 5000) {
      await supabase.from('email_send_errors').insert({
        error_class: 'timeout',
        error_message: `tick ran ${elapsedMs}ms (budget ${budgetMs}ms)`,
        context: { ms_elapsed: elapsedMs, stats },
      });
      log('warn', 'tick_timeout', { ms_elapsed: elapsedMs, stats });
    }

    return NextResponse.json({ ok: true, ms_elapsed: elapsedMs, ...stats });
  } catch (err) {
    const e = err as Error;
    const elapsedMs = Date.now() - startedAt;

    // C9: write crash row + check threshold + pause-all if exceeded
    await supabase.from('email_send_errors').insert({
      error_class: 'crash',
      error_code: e.constructor.name,
      error_message: e.message,
      context: { stack: e.stack ?? null, ms_elapsed: elapsedMs },
    });
    log('error', 'tick_crash', { err: e.message, ms_elapsed: elapsedMs });

    // Crash counter — count crashes since the most recent reset marker (or
    // the window start, whichever is newer)
    const windowStart = new Date(
      Date.now() - SAFETY_LIMITS.CRASH_COUNTER_WINDOW_MINUTES * 60_000,
    ).toISOString();
    const { data: schedule } = await supabase
      .from('email_send_schedule')
      .select('crashes_counter_reset_at')
      .eq('id', 1)
      .single();
    const resetAt = (schedule as { crashes_counter_reset_at: string | null } | null)?.crashes_counter_reset_at;
    const effectiveStart = resetAt && new Date(resetAt) > new Date(windowStart) ? resetAt : windowStart;

    const { count: crashCount } = await supabase
      .from('email_send_errors')
      .select('id', { count: 'exact', head: true })
      .eq('error_class', 'crash')
      .gte('occurred_at', effectiveStart);

    if ((crashCount ?? 0) >= SAFETY_LIMITS.CRASH_COUNTER_THRESHOLD) {
      await supabase.from('team_members')
        .update({
          email_send_paused: true,
          email_send_paused_reason: 'repeated_tick_crashes',
          email_send_paused_at: new Date().toISOString(),
        })
        .neq('id', '00000000-0000-0000-0000-000000000000');
      log('error', 'tick_crash_threshold_exceeded', {
        crashes: crashCount,
        window_minutes: SAFETY_LIMITS.CRASH_COUNTER_WINDOW_MINUTES,
      });
      // PR 5 will wire Resend critical alerts here. For now, the log
      // line + paused flag are the only signals.
    }

    return NextResponse.json(
      { error: 'tick_crashed', message: e.message, ms_elapsed: elapsedMs },
      { status: 500 },
    );
  }
}
