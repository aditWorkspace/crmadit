export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { runAutoFollowup } from '@/lib/automation/auto-followup';
import { runFirstReplyAutoResponder } from '@/lib/automation/first-reply-responder';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // allSettled so one blowing up doesn't kill the other. first-reply-responder
  // handles replied-stage leads (new); runAutoFollowup handles scheduling-stage
  // nudge (existing). Their filters no longer overlap since auto-followup was
  // narrowed to ['scheduling'].
  const [firstReplySettled, nudgeSettled] = await Promise.allSettled([
    runFirstReplyAutoResponder(),
    runAutoFollowup(),
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
  });
}

export const GET = handler;
export const POST = handler;
