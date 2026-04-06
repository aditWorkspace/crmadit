import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect /api/* routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow health checks and cron routes (cron routes validated by their own secret)
  const allowedWithoutSession = [
    '/api/health',
    '/api/gmail/callback',
    '/api/cron/',
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
