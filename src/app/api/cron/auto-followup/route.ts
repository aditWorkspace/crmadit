export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup } from '@/lib/automation/auto-followup';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runAutoFollowup();

  return NextResponse.json({ status: 'done', ...result });
}

export const GET = handler;
export const POST = handler;
