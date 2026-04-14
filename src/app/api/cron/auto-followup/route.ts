export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup } from '@/lib/automation/auto-followup';
import { runFirstReplyAutoResponder } from '@/lib/automation/first-reply-responder';
import { drainScheduledEmails } from '@/lib/automation/send-guards';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Three jobs run in parallel:
  // 1. first-reply-responder: classifies new prospect replies, sends during biz hours
  // 2. runAutoFollowup: evaluates scheduling-stage leads, queues follow-ups
  // 3. drainScheduledEmails: sends any queued emails whose scheduled_for has passed
  const [firstReplySettled, nudgeSettled, drainSettled] = await Promise.allSettled([
    runFirstReplyAutoResponder(),
    runAutoFollowup(),
    drainScheduledEmails(),
  ]);

  return NextResponse.json({
    status: 'done',
    first_reply:
      firstReplySettled.status === 'fulfilled'
        ? firstReplySettled.value
        : { error: String(firstReplySettled.reason) },
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
