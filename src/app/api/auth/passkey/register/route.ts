import { NextRequest, NextResponse } from 'next/server';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

const RP_NAME = 'Proxi CRM';

function getWebAuthnConfig(req: NextRequest) {
  const host = req.headers.get('host') || 'localhost';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const rpId = host.split(':')[0]; // Remove port if present
  const origin = `${protocol}://${host}`;
  return { rpId, origin };
}

// In-memory challenge store (fine for 3 users)
const challengeStore = new Map<string, string>();

export async function GET(req: NextRequest) {
  // Allow registration during login flow via header, or when logged in
  const memberId = req.headers.get('x-team-member-id');
  const session = await getSessionFromRequest(req);

  const targetId = memberId || session?.id;
  if (!targetId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get member info
  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, name, email')
    .eq('id', targetId)
    .single();

  if (!member) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  const { rpId } = getWebAuthnConfig(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userID: new TextEncoder().encode(member.id),
    userName: member.email || member.name,
    userDisplayName: member.name,
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // Touch ID, Face ID, Windows Hello
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });

  challengeStore.set(member.id, options.challenge);
  // Auto-expire challenge after 5 min
  setTimeout(() => challengeStore.delete(member.id), 5 * 60 * 1000);

  return NextResponse.json(options);
}

export async function POST(req: NextRequest) {
  // Allow registration during login flow via header, or when logged in
  const memberId = req.headers.get('x-team-member-id');
  const session = await getSessionFromRequest(req);

  const targetId = memberId || session?.id;
  if (!targetId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expectedChallenge = challengeStore.get(targetId);
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });
  }

  const body: RegistrationResponseJSON = await req.json();

  try {
    const { rpId, origin } = getWebAuthnConfig(req);
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const { credential } = verification.registrationInfo;

    // Store the credential
    const supabase = createAdminClient();
    const { error } = await supabase
      .from('team_members')
      .update({
        passkey_credential_id: Buffer.from(credential.id).toString('base64url'),
        passkey_public_key: Buffer.from(credential.publicKey).toString('base64url'),
        passkey_counter: credential.counter,
      })
      .eq('id', targetId);

    if (error) {
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
    }

    challengeStore.delete(targetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
