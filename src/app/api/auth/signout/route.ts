import { NextResponse } from 'next/server';
import { clearedCookieOptions } from '@/lib/auth/cookie-session';

export async function POST() {
  const opts = clearedCookieOptions();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(opts.name, '', {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
  });
  return res;
}

export async function GET() {
  // Convenience: GET /api/auth/signout clears cookie and redirects home
  const opts = clearedCookieOptions();
  const res = NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'));
  res.cookies.set(opts.name, '', {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
  });
  return res;
}
