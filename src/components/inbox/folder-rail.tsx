'use client';

import { Mail, Send, Clock, Trash2, CheckCheck, BellOff } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { InboxFilter, InboxCounts } from '@/hooks/use-inbox-counts';

interface FolderRailProps {
  filter: InboxFilter;
  onFilterChange: (f: InboxFilter) => void;
  counts: InboxCounts;
}

interface Item {
  id: InboxFilter;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  countKey: keyof InboxCounts;
  // Whether to render the count as an unread-style badge (blue) or muted (gray).
  emphasized?: boolean;
}

const ITEMS: Item[] = [
  { id: 'needs_response', label: 'Needs Response', icon: Mail, countKey: 'needs_response', emphasized: true },
  { id: 'unread', label: 'Unread', icon: BellOff, countKey: 'unread', emphasized: true },
  { id: 'all', label: 'All', icon: CheckCheck, countKey: 'all' },
  { id: 'sent', label: 'Sent', icon: Send, countKey: 'sent' },
  { id: 'snoozed', label: 'Snoozed', icon: Clock, countKey: 'snoozed' },
  { id: 'archived', label: 'Archived', icon: Trash2, countKey: 'archived' },
];

export function FolderRail({ filter, onFilterChange, counts }: FolderRailProps) {
  return (
    <nav className="flex flex-col gap-0.5 py-3 px-2 text-[13px]" aria-label="Inbox folders">
      <div className="label-uppercase px-2 pb-2">Inbox</div>
      {ITEMS.map(item => {
        const Icon = item.icon;
        const active = filter === item.id;
        const count = counts[item.countKey] ?? 0;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onFilterChange(item.id)}
            className={cn(
              'group flex items-center gap-2.5 rounded-[var(--radius-soft)] px-2.5 py-1.5 text-left transition-colors',
              active
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            <Icon className={cn('h-4 w-4 flex-shrink-0', active ? 'text-white' : 'text-gray-400 group-hover:text-gray-600')} />
            <span className="flex-1 truncate">{item.label}</span>
            {count > 0 && (
              <span
                className={cn(
                  'text-[11px] rounded-full px-1.5 py-0.5 font-medium tabular-nums',
                  active
                    ? 'bg-white/20 text-white'
                    : item.emphasized
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-500'
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
