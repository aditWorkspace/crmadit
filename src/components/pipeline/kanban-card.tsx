'use client';

import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Lead, LeadStage } from '@/types';
import { PRIORITY_COLORS, STALE_THRESHOLDS } from '@/lib/constants';
import { cn, formatRelativeTime } from '@/lib/utils';
import { differenceInHours } from 'date-fns';
import { Flame } from 'lucide-react';
import Link from 'next/link';

interface KanbanCardProps {
  lead: Lead;
  isDragging?: boolean;
}

function getDaysInStage(lead: Lead): number {
  const ref = lead.updated_at || lead.created_at;
  return Math.floor(differenceInHours(new Date(), new Date(ref)) / 24);
}

function isStale(lead: Lead): boolean {
  const thresholdHrs = STALE_THRESHOLDS[lead.stage as LeadStage];
  if (!thresholdHrs || !lead.last_contact_at) return false;
  const hoursSince = differenceInHours(new Date(), new Date(lead.last_contact_at));
  return hoursSince > thresholdHrs;
}

export function KanbanCard({ lead, isDragging }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: lead.id,
    data: { lead },
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const stale = isStale(lead);
  const daysInStage = getDaysInStage(lead);
  const staleColor = stale ? 'text-red-500' : daysInStage > 3 ? 'text-orange-400' : 'text-green-500';
  const heatColor = lead.heat_score >= 70 ? 'text-red-400' : lead.heat_score >= 40 ? 'text-orange-400' : 'text-gray-300';

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(
        'rounded-lg border bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing select-none',
        'hover:shadow-md transition-shadow',
        isDragging && 'opacity-50 shadow-lg rotate-1',
        stale && 'border-red-200',
        !stale && 'border-gray-100',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/leads/${lead.id}`}
            onClick={e => e.stopPropagation()}
            className="text-sm font-medium text-gray-900 hover:text-blue-600 line-clamp-1"
          >
            {lead.contact_name}
          </Link>
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
            {lead.company_name}
            {lead.contact_role ? ` · ${lead.contact_role}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Flame className={cn('h-3.5 w-3.5', heatColor)} />
          <span className={cn('h-2 w-2 rounded-full flex-shrink-0', PRIORITY_COLORS[lead.priority])} />
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between text-xs">
        <span className={cn('font-medium', staleColor)}>
          {daysInStage === 0 ? 'Today' : `${daysInStage}d in stage`}
          {stale && ' · STALE'}
        </span>
        <span className="text-gray-400">
          {(lead.owned_by_member as { name: string } | undefined)?.name || '—'}
        </span>
      </div>

      {lead.next_followup_at && (
        <div className="mt-1.5 text-xs text-gray-400 truncate">
          Next: {formatRelativeTime(lead.next_followup_at)}
        </div>
      )}
    </div>
  );
}
