import { NextRequest, NextResponse } from 'next/server';
import { runAutoStageAdvance } from '@/lib/automation/stage-auto-advance';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runAutoStageAdvance();
  console.log('[cron/auto-stage]', result);
  return NextResponse.json({ status: 'done', ...result });
}
