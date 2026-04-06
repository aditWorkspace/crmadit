import { NextRequest } from 'next/server';
import { createAdminClient } from './supabase/admin';
import { TeamMember } from '@/types';

export async function getSessionFromRequest(req: NextRequest): Promise<TeamMember | null> {
  const memberId = req.headers.get('x-team-member-id');
  if (!memberId) return null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, email, major, gmail_connected, gmail_token_expires_at, created_at')
    .eq('id', memberId)
    .single();

  if (error || !data) return null;
  return data as TeamMember;
}

export function requireSession(teamMember: TeamMember | null): TeamMember {
  if (!teamMember) {
    throw new Error('Unauthorized: no valid session');
  }
  return teamMember;
}
