import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { signSession, sessionCookieOptions } from '@/lib/auth/cookie-session';

/**
 * POST /api/auth/verify
 * Body: { memberId: string; memberName: string; password: string }
 *
 * Validates the PIN against server-only env vars (raw PINs never in JS bundle).
 * On success, sets an HTTP-only signed session cookie.
 */

const PIN_BY_NAME: Record<string, string | undefined> = {
  srijay: process.env.FOUNDER_PIN_SRIJAY,
  adit:   process.env.FOUNDER_PIN_ADIT,
  asim:   process.env.FOUNDER_PIN_ASIM,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function constantTimeEq(a: string, b: string): boolean {
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export async function POST(req: NextRequest) {
  try {
    const { memberId, memberName, password } = await req.json() as {
      memberId?: string;
      memberName?: string;
      password?: string;
    };

    if (!memberId || !memberName || !password) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }
    if (!UUID_RE.test(memberId)) {
      return NextResponse.json({ error: 'Invalid member id' }, { status: 400 });
    }

    const key = memberName.toLowerCase().trim();
    const expected = PIN_BY_NAME[key];

    if (!expected) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 401 });
    }

    if (!constantTimeEq(password.trim(), expected.trim())) {
      return NextResponse.json({ error: 'Incorrect PIN' }, { status: 401 });
    }

    const token = signSession(memberId);
    const opts = sessionCookieOptions();
    const res = NextResponse.json({ ok: true, memberId });
    res.cookies.set(opts.name, token, {
      httpOnly: opts.httpOnly,
      secure: opts.secure,
      sameSite: opts.sameSite,
      path: opts.path,
      maxAge: opts.maxAge,
    });
    return res;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
