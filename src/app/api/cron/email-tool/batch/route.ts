// POST /api/cron/email-tool/batch — request the next batch of 400 emails.
//
// Auth: cookie session via getSessionFromRequest (the user has to be a
// team member; admin not required). Lives under /api/cron/* because
// Vercel deployment-protection HTML-404s authenticated POSTs to most
// other /api/* paths (same workaround as granola-user-sync, action-chat,
// advisor-transcripts).
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { runBatch } from '@/lib/email-tool/pool';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 });

  const result = await runBatch({
    teamMemberId:    session.id,
    teamMemberName:  session.name,
    teamMemberEmail: session.email,
    cooldownAt:      session.email_batch_next_at ?? null,
  });

  // Surface the same response shape the standalone tool used so the
  // ported dashboard UI works without changes.
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      url: result.url,
      nextAvailable: result.nextAvailableAt,
      remaining: result.freshRemaining,
      newEntry: { url: result.url, title: result.title, createdAt: new Date().toISOString(), createdBy: session.name },
    });
  }
  if (result.reason === 'cooldown')   return NextResponse.json({ ok: false, reason: 'cooldown',   retryAt: result.retryAt });
  if (result.reason === 'exhausted')  return NextResponse.json({ ok: false, reason: 'exhausted',  remaining: result.remaining });
  if (result.reason === 'sheet_error') return NextResponse.json({ ok: false, reason: 'sheet_error', detail: result.detail }, { status: 500 });
  return NextResponse.json({ ok: false, reason: 'unknown', detail: result.detail }, { status: 500 });
}
