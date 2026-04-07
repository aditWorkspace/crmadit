import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/auth/verify
 * Body: { memberId: string; memberName: string; password: string }
 *
 * Compares the submitted PIN against server-only env vars.
 * Raw PINs live only in Vercel env vars — never in the JS bundle.
 */

const PIN_BY_NAME: Record<string, string | undefined> = {
  srijay: process.env.FOUNDER_PIN_SRIJAY,
  adit:   process.env.FOUNDER_PIN_ADIT,
  asim:   process.env.FOUNDER_PIN_ASIM,
};

export async function POST(req: NextRequest) {
  try {
    const { memberId, memberName, password } = await req.json() as {
      memberId?: string;
      memberName?: string;
      password?: string;
    };

    if (!memberName || !password) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const key = memberName.toLowerCase().trim();
    const expected = PIN_BY_NAME[key];

    if (!expected) {
      return NextResponse.json({ error: `No PIN set for "${key}" — env var missing` }, { status: 401 });
    }

    // Trim both sides in case of accidental whitespace in Vercel dashboard
    if (password.trim() !== expected.trim()) {
      return NextResponse.json({
        error: 'Incorrect PIN',
        debug: `expected length=${expected.trim().length}, got length=${password.trim().length}`,
      }, { status: 401 });
    }

    return NextResponse.json({ ok: true, memberId });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
