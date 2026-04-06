'use client';

import { ActivityLog } from '@/types';
import { formatRelativeTime } from '@/lib/utils';
import Link from 'next/link';

interface ActivityFeedProps {
  activities: ActivityLog[];
}

function formatAction(action: string, details?: Record<string, unknown>): string {
  switch (action) {
    case 'stage_changed': return `moved to ${details?.to}`;
    case 'lead_created': return 'added lead';
    case 'note_added': return 'added a note';
    case 'transcript_applied': return 'uploaded transcript';
    case 'lead_reassigned': return 'reassigned lead';
    case 'lead_archived': return 'archived lead';
    default: return action.replace(/_/g, ' ');
  }
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  if (activities.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No recent activity.</p>;
  }

  return (
    <div className="space-y-1">
      {activities.map(activity => {
        const member = activity.team_member as { name: string } | undefined;
        const lead = activity.lead as { id: string; contact_name: string; company_name: string } | undefined;
        return (
          <div key={activity.id} className="flex items-start gap-3 py-1.5 text-sm">
            <span className="text-gray-400 text-xs w-20 flex-shrink-0 pt-0.5" title={activity.created_at}>
              {formatRelativeTime(activity.created_at)}
            </span>
            <span className="text-gray-600 flex-1 min-w-0">
              <span className="font-medium text-gray-700">{member?.name || 'System'}</span>
              {' '}{formatAction(activity.action, activity.details)}
              {lead && (
                <>
                  {' '}for{' '}
                  <Link href={`/leads/${lead.id}`} className="text-blue-500 hover:underline">
                    {lead.contact_name}
                  </Link>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
