export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runBulkScoring } from '@/lib/automation/lead-scoring';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await runBulkScoring();
  return NextResponse.json({ ok: true, ...result });
}
