import { NextRequest } from 'next/server';
import { createAdminClient } from './supabase/admin';
import { TeamMember } from '@/types';
import { SESSION_COOKIE_NAME, verifySession } from './auth/cookie-session';

// In-process cache — only 3 members ever, TTL 5 min
const memberCache = new Map<string, { member: TeamMember; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Reads team member from the signed session cookie. The legacy
 * x-team-member-id header path has been REMOVED — without a valid
 * cookie, every request is unauthenticated.
 */
export async function getSessionFromRequest(req: NextRequest): Promise<TeamMember | null> {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const payload = verifySession(cookie);
  if (!payload) return null;

  const memberId = payload.tm;

  const cached = memberCache.get(memberId);
  if (cached && cached.expiresAt > Date.now()) return cached.member;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, email, major, gmail_connected, gmail_token_expires_at, created_at')
    .eq('id', memberId)
    .single();

  if (error || !data) return null;
  memberCache.set(memberId, { member: data as TeamMember, expiresAt: Date.now() + CACHE_TTL_MS });
  return data as TeamMember;
}

export function requireSession(teamMember: TeamMember | null): TeamMember {
  if (!teamMember) {
    throw new Error('Unauthorized: no valid session');
  }
  return teamMember;
}
