import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup, enqueueAutoFollowups } from '@/lib/automation/auto-followup';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // First enqueue any new follow-ups that qualify, then send pending ones
  await enqueueAutoFollowups();
  const result = await runAutoFollowup();

  return NextResponse.json({ status: 'done', ...result });
}
