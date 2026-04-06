'use client';

import { useState, useEffect } from 'react';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { TeamMember } from '@/types';

export function UserSelectorModal() {
  const { user, setUser, isLoading } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    createClient()
      .from('team_members')
      .select('id, name, email, gmail_connected')
      .order('name')
      .then(({ data }) => {
        setMembers((data as TeamMember[]) || []);
        setFetching(false);
      });
  }, []);

  if (isLoading || fetching || user) return null;

  const avatarColors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
      <div className="w-full max-w-lg px-8">
        <div className="mb-12 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Proxi CRM</h1>
          <p className="mt-2 text-gray-500">Who are you?</p>
        </div>
        <div className="flex gap-4 justify-center">
          {members.map((member, i) => (
            <button
              key={member.id}
              onClick={() => setUser({ team_member_id: member.id, name: member.name })}
              className="flex flex-col items-center gap-3 rounded-2xl border border-gray-200 p-8 hover:border-gray-300 hover:bg-gray-50 transition-all cursor-pointer w-40"
            >
              <div className={`h-16 w-16 rounded-full ${avatarColors[i % avatarColors.length]} flex items-center justify-center text-2xl font-semibold text-white`}>
                {member.name[0]}
              </div>
              <span className="text-lg font-medium text-gray-900">{member.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
