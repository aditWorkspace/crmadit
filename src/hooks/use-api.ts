'use client';

import { useSession } from './use-session';

export function useApiHeaders(): Record<string, string> {
  const { user } = useSession();
  return user ? { 'x-team-member-id': user.team_member_id } : {};
}

export async function apiFetch(
  path: string,
  options: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
  memberId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (memberId) headers['x-team-member-id'] = memberId;
  return fetch(path, { ...options, headers });
}
