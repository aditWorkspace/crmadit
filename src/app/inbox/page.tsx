'use client';

import { useState, useEffect } from 'react';
import { useSession } from '@/hooks/use-session';
import { StageBadge } from '@/components/leads/stage-badge';
import { Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { formatDate } from '@/lib/utils';

interface InboxEmail {
  id: string;
  subject: string;
  body: string;
  summary: string | null;
  occurred_at: string;
  gmail_thread_id: string | null;
  lead: { id: string; contact_name: string; company_name: string; stage: string; owned_by: string } | null;
  team_member: { id: string; name: string } | null;
}

export default function InboxPage() {
  const { user } = useSession();
  const [emails, setEmails] = useState<InboxEmail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    fetch('/api/inbox', { headers: { 'x-team-member-id': user.team_member_id } })
      .then(r => r.json())
      .then(d => { setEmails(d.emails || []); setLoading(false); });
  }, [user]);

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-8 py-5 flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Team Inbox</h1>
        <p className="text-sm text-gray-500 mt-0.5">All inbound emails across the team — last 50.</p>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-2">
            <Mail className="h-8 w-8" />
            <p className="text-sm">No inbound emails yet. Connect Gmail to start syncing.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {emails.map(email => (
              <Link
                key={email.id}
                href={email.lead ? `/leads/${email.lead.id}` : '#'}
                className="flex items-start gap-4 px-8 py-4 hover:bg-gray-50 transition-colors group"
              >
                {/* Avatar */}
                <div className="h-9 w-9 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Mail className="h-4 w-4 text-gray-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {email.lead?.contact_name || 'Unknown'} · {email.lead?.company_name || '—'}
                      </span>
                      {email.lead && <StageBadge stage={email.lead.stage as never} />}
                    </div>
                    <span className="text-xs text-gray-400 flex-shrink-0">{formatDate(email.occurred_at)}</span>
                  </div>
                  <p className="text-sm text-gray-700 truncate">{email.subject || '(no subject)'}</p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {email.summary || email.body?.slice(0, 120) || ''}
                  </p>
                </div>

                {email.team_member && (
                  <div className="flex-shrink-0 text-xs text-gray-400">→ {email.team_member.name}</div>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
