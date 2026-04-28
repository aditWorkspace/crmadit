// Diagnostic-only: does the Lambda see the three OAuth env vars?
// Returns presence flags + length, never values. Behind session auth so
// it's not public.
//
// REMOVE after PR 3 smoke-test passes — this is a one-off troubleshooter,
// not part of the long-term API surface.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN'];
  const report: Record<string, { present: boolean; length: number }> = {};
  for (const k of keys) {
    const v = process.env[k];
    report[k] = { present: !!v, length: v?.length ?? 0 };
  }
  return NextResponse.json({ report });
}
