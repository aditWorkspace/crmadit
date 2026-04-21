import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/auth/cookie-session';

/**
 * Global gate. Every route requires a valid signed session cookie EXCEPT:
 *   - /api/auth/*       (signin / signout / pin endpoints)
 *   - /api/cron/*       (own bearer auth via CRON_SECRET)
 *   - /api/health       (uptime probe)
 *   - /api/team/members (PIN screen needs to list members BEFORE signin)
 *   - /api/gmail/callback (Google OAuth redirect target — no cookie yet possible)
 *   - /favicon.ico, /_next/*, static assets
 *
 * Behavior on missing/invalid cookie:
 *   - HTML navigations  → 200 with the home page (modal will gate UI)
 *                         actually we let the request through so the
 *                         user-selector modal renders. The modal already
 *                         hides all content until signed in.
 *   - API requests      → 401 JSON
 */

const PUBLIC_API_PREFIXES = [
  '/api/auth/',
  '/api/cron/',
  '/api/health',
  '/api/team/members',
  '/api/gmail/callback',
  '/api/calendar/availability',  // Public booking page needs this
  '/api/calendar/book',          // Public booking page needs this
  '/api/calendar/reschedule',    // Public reschedule flow
];

function isPublicPath(pathname: string): boolean {
  if (pathname === '/favicon.ico' || pathname === '/robots.txt') return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/fonts/')) return true;
  for (const p of PUBLIC_API_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  return false;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const payload = verifySession(cookie);

  if (payload) {
    return NextResponse.next();
  }

  // No / invalid cookie. For API → 401 JSON. For pages → let through so the
  // user-selector modal renders (it gates all UI behind a PIN already; with
  // no cookie, no API call will succeed even if the UI is reached).
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
