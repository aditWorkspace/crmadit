import { createHmac, timingSafeEqual } from 'crypto';

// HMAC-signed session cookie. No external deps.
// Format: base64url(JSON({tm, exp, v})) + "." + base64url(HMAC-SHA256(payload, secret))

export const SESSION_COOKIE_NAME = 'crm_session';
const SESSION_VERSION = 2;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

interface SessionPayload {
  tm: string;          // team_member_id (UUID)
  exp: number;         // epoch ms
  v: number;           // version (rotate to invalidate all sessions)
}

function getSecret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET env var missing or too short (need >=32 chars)');
  }
  return Buffer.from(s, 'utf8');
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signSession(teamMemberId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload: SessionPayload = {
    tm: teamMemberId,
    exp: Date.now() + ttlMs,
    v: SESSION_VERSION,
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let secret: Buffer;
  try { secret = getSecret(); } catch { return null; }

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest();
  let providedSig: Buffer;
  try { providedSig = b64urlDecode(sigB64); } catch { return null; }
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: SessionPayload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); } catch { return null; }

  if (payload.v !== SESSION_VERSION) return null;
  if (typeof payload.tm !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.tm)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;

  return payload;
}

export function sessionCookieOptions(ttlMs = DEFAULT_TTL_MS) {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  };
}

export function clearedCookieOptions() {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}
