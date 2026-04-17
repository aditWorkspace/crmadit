'use client';

import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { ownerColor } from '@/lib/colors';
import { STAGE_LABELS, STAGE_COLORS } from '@/lib/constants';
import type { LeadStage } from '@/types';
import type { InboxThread } from '@/hooks/use-thread-list';

interface ThreadRowProps {
  thread: InboxThread;
  selected: boolean;
  onSelect: () => void;
}

/** Format a participant name like "Jane D." for compact rows. */
function shortName(name: string | null | undefined): string {
  if (!name) return 'Unknown';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    if (diff < dayMs) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (diff < 7 * dayMs) {
      return d.toLocaleDateString([], { weekday: 'short' });
    }
    return formatDistanceToNow(d, { addSuffix: false });
  } catch {
    return '';
  }
}

export function ThreadRow({ thread, selected, onSelect }: ThreadRowProps) {
  const oc = ownerColor(thread.owner_name);
  const unread = thread.is_unread;
  const contactName = thread.lead_contact_name || 'Unknown';
  const company = thread.lead_company_name;
  const stage = (thread.lead_stage as LeadStage | null) ?? null;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-thread-id={thread.gmail_thread_id}
      data-selected={selected}
      className={cn(
        'relative flex w-full gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-blue-50/60' : 'hover:bg-gray-50',
      )}
    >
      {/* Unread blue bar */}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-0 h-full w-0.5 rounded-r',
          unread ? 'bg-blue-500' : 'bg-transparent'
        )}
      />

      {/* Owner dot */}
      <span
        className={cn('mt-1.5 h-2 w-2 rounded-full flex-shrink-0', oc.dot)}
        title={thread.owner_name || 'Unassigned'}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'truncate text-[13px]',
              unread ? 'font-semibold text-gray-900' : 'text-gray-800'
            )}
          >
            {shortName(contactName)}
            {company && (
              <span className="ml-1.5 text-xs font-normal text-gray-400">
                · {company}
              </span>
            )}
          </span>
          <span className="flex-shrink-0 text-[11px] text-gray-400 tabular-nums">
            {shortTime(thread.last_message_at)}
          </span>
        </div>

        <div
          className={cn(
            'truncate text-[13px]',
            unread ? 'font-medium text-gray-900' : 'text-gray-700'
          )}
        >
          {thread.subject}
          {thread.message_count > 1 && (
            <span className="ml-1 text-[11px] text-gray-400">
              ({thread.message_count})
            </span>
          )}
        </div>

        {thread.snippet && (
          <div className="truncate text-xs text-gray-500 mt-0.5">
            {thread.snippet}
          </div>
        )}

        {stage && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-medium',
                STAGE_COLORS[stage]
              )}
            >
              {STAGE_LABELS[stage]}
            </span>
            {thread.snoozed_until && (
              <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-[1px]">
                Snoozed
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
