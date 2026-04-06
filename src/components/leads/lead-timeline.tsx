'use client';

import { useState } from 'react';
import { Interaction, ActivityLog } from '@/types';
import { formatRelativeTime, formatDateTime, cn } from '@/lib/utils';
import {
  Mail, MessageSquare, Phone, Star, ArrowRight, RefreshCw, Send, Zap
} from 'lucide-react';

const INTERACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  email_inbound: Mail,
  email_outbound: Send,
  call: Phone,
  note: MessageSquare,
  demo_sent: Star,
  follow_up_auto: Zap,
  stage_change: ArrowRight,
  other: RefreshCw,
};

interface LeadTimelineProps {
  interactions: Interaction[];
  activities: ActivityLog[];
}

function InteractionEntry({ item }: { item: Interaction & { team_member?: { name: string } } }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = INTERACTION_ICONS[item.type] || MessageSquare;
  const isEmail = item.type === 'email_inbound' || item.type === 'email_outbound';
  const isStageChange = item.type === 'stage_change';

  return (
    <div className={cn('flex gap-3 py-3', isStageChange && 'opacity-70')}>
      <div className="flex-shrink-0 mt-0.5">
        <div className={cn(
          'h-7 w-7 rounded-full flex items-center justify-center',
          item.type === 'email_inbound' && 'bg-blue-100',
          item.type === 'email_outbound' && 'bg-green-100',
          item.type === 'note' && 'bg-yellow-100',
          item.type === 'call' && 'bg-purple-100',
          item.type === 'follow_up_auto' && 'bg-orange-100',
          item.type === 'stage_change' && 'bg-gray-100',
          item.type === 'demo_sent' && 'bg-teal-100',
        )}>
          <Icon className="h-3.5 w-3.5 text-gray-600" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-gray-600">
            {item.team_member?.name || 'System'}
          </span>
          <span className="text-xs text-gray-400" title={formatDateTime(item.occurred_at)}>
            {formatRelativeTime(item.occurred_at)}
          </span>
        </div>
        {item.subject && (
          <p className="text-sm font-medium text-gray-800 mt-0.5">{item.subject}</p>
        )}
        {item.body && (
          <div className={cn('mt-1', isEmail && !expanded && 'line-clamp-2')}>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{item.body}</p>
            {isEmail && item.body.length > 150 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-blue-600 hover:underline mt-1"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatActivityText(activity: ActivityLog): string {
  const details = (activity.details as Record<string, unknown>) || {};
  switch (activity.action) {
    case 'stage_changed': return `Stage changed: ${details.from} → ${details.to}`;
    case 'note_added': return `Note added${details.pinned ? ' (pinned)' : ''}`;
    case 'lead_archived': return 'Lead archived';
    case 'lead_reassigned': return 'Lead reassigned to new owner';
    default: return activity.action.replace(/_/g, ' ');
  }
}

export function LeadTimeline({ interactions, activities }: LeadTimelineProps) {
  const entries = [
    ...interactions.map(i => ({ ...i, _source: 'interaction' as const, _sortKey: i.occurred_at })),
    ...activities
      .filter(a => !['lead_created', 'lead_updated'].includes(a.action))
      .map(a => ({
        ...a,
        occurred_at: a.created_at,
        type: 'other' as const,
        body: formatActivityText(a),
        _source: 'activity' as const,
        _sortKey: a.created_at,
        metadata: {} as Record<string, unknown>,
      })),
  ].sort((a, b) => new Date(b._sortKey).getTime() - new Date(a._sortKey).getTime());

  if (entries.length === 0) {
    return (
      <div className="py-12 text-center text-gray-400 text-sm">
        No activity yet. Add a note or sync Gmail to see the timeline.
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-50">
      {entries.map((entry, i) => (
        <InteractionEntry key={`${entry._source}-${entry.id}`} item={entry as Interaction & { team_member?: { name: string } }} />
      ))}
    </div>
  );
}
