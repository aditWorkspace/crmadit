export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup } from '@/lib/automation/auto-followup';
import { runAutoReplyPipeline } from '@/lib/automation/auto-reply-pipeline';
import { drainAutoReplyQueue } from '@/lib/automation/drain-auto-reply-queue';
import { drainScheduledEmails } from '@/lib/automation/send-guards';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Four jobs run in parallel:
  // 1. auto-reply-pipeline: multi-stage classification + queuing (30-60 min delay)
  // 2. drainAutoReplyQueue: sends queued auto-replies after delay, re-checks human reply
  // 3. runAutoFollowup: evaluates scheduling-stage leads, queues follow-ups
  // 4. drainScheduledEmails: sends any queued emails whose scheduled_for has passed
  const [pipelineSettled, autoReplyDrainSettled, nudgeSettled, drainSettled] = await Promise.allSettled([
    runAutoReplyPipeline(),
    drainAutoReplyQueue(),
    runAutoFollowup(),
    drainScheduledEmails(),
  ]);

  return NextResponse.json({
    status: 'done',
    pipeline:
      pipelineSettled.status === 'fulfilled'
        ? pipelineSettled.value
        : { error: String(pipelineSettled.reason) },
    auto_reply_drain:
      autoReplyDrainSettled.status === 'fulfilled'
        ? autoReplyDrainSettled.value
        : { error: String(autoReplyDrainSettled.reason) },
    nudge:
      nudgeSettled.status === 'fulfilled'
        ? nudgeSettled.value
        : { error: String(nudgeSettled.reason) },
    drain:
      drainSettled.status === 'fulfilled'
        ? drainSettled.value
        : { error: String(drainSettled.reason) },
  });
}

export const GET = handler;
export const POST = handler;
