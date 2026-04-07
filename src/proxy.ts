import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect /api/* routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow health checks and cron routes (cron routes validated by their own secret)
  const allowedWithoutSession = [
    '/api/health',
    '/api/gmail/connect',
    '/api/gmail/callback',
    '/api/cron/',
    '/api/calendar/availability', // public — used by /book page (no session)
    '/api/calendar/book',         // public — used by /book page (no session)
    '/api/team/members',          // public — used by user selector before login
    '/api/auth/verify',           // public — used by login screen before session exists
  ];

  const isAllowed = allowedWithoutSession.some(p => pathname.startsWith(p));
  if (isAllowed) return NextResponse.next();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const memberId = request.headers.get('x-team-member-id');
  if (!memberId || !UUID_RE.test(memberId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
