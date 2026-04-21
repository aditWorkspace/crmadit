import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { signSession, sessionCookieOptions } from '@/lib/auth/cookie-session';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/auth/verify
 * Body: { memberId: string; memberName: string; password: string }
 *
 * Validates the password against server-only env vars.
 * Rate limited: 5 attempts per 15 minutes, then locked out.
 */

const PASSWORD_BY_NAME: Record<string, string | undefined> = {
  srijay: process.env.FOUNDER_PIN_SRIJAY,
  adit:   process.env.FOUNDER_PIN_ADIT,
  asim:   process.env.FOUNDER_PIN_ASIM,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limiting: 5 failed attempts per 15 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>();

function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = failedAttempts.get(key);

  if (!record) return { allowed: true };

  // Reset if window expired
  if (now - record.firstAttempt > LOCKOUT_MS) {
    failedAttempts.delete(key);
    return { allowed: true };
  }

  if (record.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((record.firstAttempt + LOCKOUT_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

function recordFailure(key: string): void {
  const now = Date.now();
  const record = failedAttempts.get(key);

  if (!record || now - record.firstAttempt > LOCKOUT_MS) {
    failedAttempts.set(key, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}

function clearFailures(key: string): void {
  failedAttempts.delete(key);
}

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

    // Rate limit check (by member ID to prevent brute force)
    const rateKey = `login:${memberId}`;
    const rateCheck = checkRateLimit(rateKey);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${rateCheck.retryAfter}s` },
        { status: 429 }
      );
    }

    const key = memberName.toLowerCase().trim();
    const expected = PASSWORD_BY_NAME[key];

    if (!expected) {
      recordFailure(rateKey);
      return NextResponse.json({ error: 'Auth not configured' }, { status: 401 });
    }

    if (!constantTimeEq(password.trim(), expected.trim())) {
      recordFailure(rateKey);
      // Log failed attempt
      const supabase = createAdminClient();
      void supabase.from('activity_log').insert({
        action: 'login_failed',
        team_member_id: memberId,
        details: { ip: req.headers.get('x-forwarded-for') || 'unknown' },
      }); // Fire and forget
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    // Success - clear rate limit and log
    clearFailures(rateKey);

    // Log successful login
    const supabase = createAdminClient();
    void supabase.from('activity_log').insert({
      action: 'login_success',
      team_member_id: memberId,
      details: { ip: req.headers.get('x-forwarded-for') || 'unknown' },
    }); // Fire and forget

    // Set session cookie
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
