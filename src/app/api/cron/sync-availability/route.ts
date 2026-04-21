import { NextRequest, NextResponse } from 'next/server';
import { verifyCronAuth } from '@/lib/auth/cron';
import { warmAvailabilityCache } from '@/lib/calendar/availability-cache';

async function handler(req: NextRequest) {
  const { ok } = verifyCronAuth(req);
  if (!ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await warmAvailabilityCache();
    return NextResponse.json({
      ok: true,
      warmed: result.warmed,
      failed: result.failed,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync-availability] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export const GET = handler;
export const POST = handler;
