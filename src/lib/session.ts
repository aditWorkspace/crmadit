import { NextRequest } from 'next/server';
import { createAdminClient } from './supabase/admin';
import { TeamMember } from '@/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Simple in-process cache — only 3 members ever, TTL 5 min
const memberCache = new Map<string, { member: TeamMember; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getSessionFromRequest(req: NextRequest): Promise<TeamMember | null> {
  const memberId = req.headers.get('x-team-member-id');
  if (!memberId || !UUID_RE.test(memberId)) return null;

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
