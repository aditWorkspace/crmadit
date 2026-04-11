export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoStageAdvance } from '@/lib/automation/stage-auto-advance';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runAutoStageAdvance();
  console.log('[cron/auto-stage]', result);
  return NextResponse.json({ status: 'done', ...result });
}

export const GET = handler;
export const POST = handler;
