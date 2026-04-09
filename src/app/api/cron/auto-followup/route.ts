export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup } from '@/lib/automation/auto-followup';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runAutoFollowup();

  return NextResponse.json({ status: 'done', ...result });
}
