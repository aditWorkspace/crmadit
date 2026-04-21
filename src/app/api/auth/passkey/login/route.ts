import { NextRequest, NextResponse } from 'next/server';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { signSession, sessionCookieOptions } from '@/lib/auth/cookie-session';

const RP_ID = process.env.NODE_ENV === 'production' ? 'pmcrminternal.vercel.app' : 'localhost';
const ORIGIN = process.env.NODE_ENV === 'production'
  ? 'https://pmcrminternal.vercel.app'
  : ['http://localhost:3000', 'http://localhost:3001'];

// Challenge store keyed by a random ID (since user isn't logged in yet)
const challengeStore = new Map<string, { challenge: string; memberId: string }>();

// GET: Generate authentication options for a specific member
export async function GET(req: NextRequest) {
  const memberId = req.nextUrl.searchParams.get('memberId');
  if (!memberId) {
    return NextResponse.json({ error: 'memberId required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, passkey_credential_id')
    .eq('id', memberId)
    .single();

  if (!member?.passkey_credential_id) {
    return NextResponse.json({ error: 'No passkey registered' }, { status: 404 });
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [{
      id: member.passkey_credential_id, // already base64url string
      transports: ['internal'],
    }],
    userVerification: 'required',
  });

  // Store challenge with a flow ID
  const flowId = crypto.randomUUID();
  challengeStore.set(flowId, { challenge: options.challenge, memberId });
  setTimeout(() => challengeStore.delete(flowId), 5 * 60 * 1000);

  return NextResponse.json({ ...options, flowId });
}

// POST: Verify authentication response
export async function POST(req: NextRequest) {
  const { flowId, ...body } = await req.json() as AuthenticationResponseJSON & { flowId: string };

  const stored = challengeStore.get(flowId);
  if (!stored) {
    return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, name, passkey_credential_id, passkey_public_key, passkey_counter')
    .eq('id', stored.memberId)
    .single();

  if (!member?.passkey_credential_id || !member?.passkey_public_key) {
    return NextResponse.json({ error: 'No passkey' }, { status: 400 });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: stored.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: member.passkey_credential_id,
        publicKey: Buffer.from(member.passkey_public_key, 'base64url'),
        counter: member.passkey_counter ?? 0,
      },
    });

    if (!verification.verified) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 401 });
    }

    // Update counter to prevent replay attacks
    await supabase
      .from('team_members')
      .update({ passkey_counter: verification.authenticationInfo.newCounter })
      .eq('id', member.id);

    challengeStore.delete(flowId);

    // Create session
    const token = signSession(member.id);
    const opts = sessionCookieOptions();
    const res = NextResponse.json({ ok: true, memberId: member.id, name: member.name });
    res.cookies.set(opts.name, token, {
      httpOnly: opts.httpOnly,
      secure: opts.secure,
      sameSite: opts.sameSite,
      path: opts.path,
      maxAge: opts.maxAge,
    });

    return res;
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
