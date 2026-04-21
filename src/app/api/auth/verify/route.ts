import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { signSession, sessionCookieOptions } from '@/lib/auth/cookie-session';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/auth/verify
 * Body: { memberId: string; memberName: string; password: string }
 *
 * Validates the password against server-only env vars.
 * If user has passkey registered, returns needs2FA: true.
 * If no passkey, sets session cookie immediately.
 */

const PASSWORD_BY_NAME: Record<string, string | undefined> = {
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
    const expected = PASSWORD_BY_NAME[key];

    if (!expected) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 401 });
    }

    if (!constantTimeEq(password.trim(), expected.trim())) {
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    // Check if localhost - skip 2FA on localhost (WebAuthn doesn't work reliably)
    const host = req.headers.get('host') || '';
    const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');

    if (isLocalhost) {
      // Localhost: password only, set session directly
      const token = signSession(memberId);
      const opts = sessionCookieOptions();
      const res = NextResponse.json({ ok: true, memberId, needs2FA: false });
      res.cookies.set(opts.name, token, {
        httpOnly: opts.httpOnly,
        secure: opts.secure,
        sameSite: opts.sameSite,
        path: opts.path,
        maxAge: opts.maxAge,
      });
      return res;
    }

    // Production: check if user has passkey for 2FA
    let hasPasskey = false;
    try {
      const supabase = createAdminClient();
      const { data: member } = await supabase
        .from('team_members')
        .select('passkey_credential_id')
        .eq('id', memberId)
        .single();
      hasPasskey = !!member?.passkey_credential_id;
    } catch {
      // Column doesn't exist yet - skip 2FA check
    }

    if (hasPasskey) {
      // Require 2FA - don't set session yet
      return NextResponse.json({ ok: true, memberId, needs2FA: true });
    }

    // No passkey registered yet - complete login (production will force registration on client)
    const token = signSession(memberId);
    const opts = sessionCookieOptions();
    const res = NextResponse.json({ ok: true, memberId, needs2FA: false });
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
