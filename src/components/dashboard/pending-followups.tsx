'use client';

import { FollowUp } from '@/types';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSession } from '@/hooks/use-session';
import { Copy, CheckCheck, Clock } from 'lucide-react';
import Link from 'next/link';

interface PendingFollowupsProps {
  followUps: FollowUp[];
  onUpdate: (id: string) => void;
}

export function PendingFollowups({ followUps, onUpdate }: PendingFollowupsProps) {
  const { user } = useSession();

  const handleComplete = async (id: string) => {
    if (!user) return;
    const res = await fetch(`/api/follow-ups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-team-member-id': user.team_member_id },
      body: JSON.stringify({ action: 'complete' }),
    });
    if (res.ok) {
      onUpdate(id);
      toast.success('Follow-up marked done');
    }
  };

  const copyMessage = (msg: string) => {
    navigator.clipboard.writeText(msg);
    toast.success('Copied to clipboard');
  };

  if (followUps.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No pending follow-ups.</p>;
  }

  return (
    <div className="space-y-3">
      {followUps.slice(0, 5).map(f => {
        const isOverdue = new Date(f.due_at) < new Date();
        const lead = f.lead as { id: string; contact_name: string; company_name: string } | undefined;
        return (
          <div key={f.id} className={cn(
            'rounded-lg border p-3 space-y-2',
            isOverdue ? 'border-red-200 bg-red-50/30' : 'border-gray-100'
          )}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5">
                  <Clock className="h-3 w-3" />
                  <span className={isOverdue ? 'text-red-500 font-medium' : ''}>
                    {isOverdue ? 'Overdue' : 'Due'} {formatRelativeTime(f.due_at)}
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-800">
                  {lead ? (
                    <Link href={`/leads/${lead.id}`} className="hover:text-blue-600">
                      {lead.contact_name} · {lead.company_name}
                    </Link>
                  ) : '—'}
                </p>
                {f.reason && <p className="text-xs text-gray-500 mt-0.5">{f.reason}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {f.suggested_message && (
                <button
                  onClick={() => copyMessage(f.suggested_message!)}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
                >
                  <Copy className="h-3 w-3" />
                  Copy
                </button>
              )}
              <button
                onClick={() => handleComplete(f.id)}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
              >
                <CheckCheck className="h-3 w-3" />
                Done
              </button>
            </div>
          </div>
        );
      })}
      {followUps.length > 5 && (
        <Link href="/follow-ups" className="text-xs text-blue-500 hover:underline">
          +{followUps.length - 5} more →
        </Link>
      )}
    </div>
  );
}
