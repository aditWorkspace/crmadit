import { NextRequest, NextResponse } from 'next/server';
import { clearedCookieOptions } from '@/lib/auth/cookie-session';

function applyClearedCookie(res: NextResponse) {
  const opts = clearedCookieOptions();
  res.cookies.set(opts.name, '', {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
  });
  return res;
}

export async function POST() {
  return applyClearedCookie(NextResponse.json({ ok: true }));
}

export async function GET(req: NextRequest) {
  // Server-driven signout: cookie cleared and redirect issued in a single
  // response so there's no client-side race between fetch and navigation.
  return applyClearedCookie(NextResponse.redirect(new URL('/', req.url)));
}
