export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runBulkScoring } from '@/lib/automation/lead-scoring';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await runBulkScoring();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handler;
export const POST = handler;
