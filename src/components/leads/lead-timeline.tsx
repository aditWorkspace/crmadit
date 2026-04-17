'use client';

import { useState } from 'react';
import { Interaction, ActivityLog } from '@/types';
import { formatDateTime, cn, stripHtml } from '@/lib/utils';
import { RelativeTime } from '@/components/ui/relative-time';
import { ArrowRight, Zap, FileText } from '@/lib/icons';

interface ReplyContext {
  threadId: string;
  subject: string;
}

interface LeadTimelineProps {
  interactions: Interaction[];
  activities: ActivityLog[];
  onReply?: (ctx: ReplyContext) => void;
}

function getInitial(name: string) {
  return name ? name[0].toUpperCase() : '?';
}

function formatActivityText(activity: ActivityLog): string {
  const details = (activity.details as Record<string, unknown>) || {};
  switch (activity.action) {
    case 'stage_changed': return `Stage moved → ${details.to}`;
    case 'note_added': return `Note added${details.pinned ? ' (pinned)' : ''}`;
    case 'lead_archived': return 'Lead archived';
    case 'lead_reassigned': return 'Lead reassigned';
    default: return activity.action.replace(/_/g, ' ');
  }
}

/* ── Single email bubble ────────────────────────────────────────────── */
function EmailBubble({
  item,
  isOutbound,
  onReply,
}: {
  item: Interaction & { team_member?: { name: string } };
  isOutbound: boolean;
  onReply?: (ctx: ReplyContext) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = stripHtml(item.body || '');
  const isLong = cleaned.length > 220;
  const preview = isLong && !expanded ? cleaned.slice(0, 220) + '…' : cleaned;
  const senderName = isOutbound
    ? (item.team_member?.name || 'Us')
    : 'Prospect';

  return (
    <div className={cn('flex gap-2.5 group', isOutbound ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div className={cn(
        'h-7 w-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold mt-1',
        isOutbound
          ? 'bg-gray-900 text-white'
          : 'bg-blue-100 text-blue-700'
      )}>
        {getInitial(senderName)}
      </div>

      {/* Bubble */}
      <div className={cn('max-w-[82%] flex flex-col', isOutbound ? 'items-end' : 'items-start')}>
        {/* Sender + time */}
        <div className={cn('flex items-baseline gap-2 mb-1 px-1', isOutbound ? 'flex-row-reverse' : 'flex-row')}>
          <span className="text-xs font-medium text-gray-700">{senderName}</span>
          <RelativeTime date={item.occurred_at} className="text-[11px] text-gray-400" />
        </div>

        {/* Subject line (only if different from thread) */}
        {item.subject && (
          <p className={cn(
            'text-[11px] font-medium mb-1 px-1 truncate max-w-full',
            isOutbound ? 'text-right text-gray-400' : 'text-gray-400'
          )}>
            {item.subject}
          </p>
        )}

        {/* Body bubble */}
        <div className={cn(
          'rounded-2xl px-4 py-3 text-sm leading-relaxed',
          isOutbound
            ? 'bg-gray-900 text-white rounded-tr-sm'
            : 'bg-white border border-gray-100 shadow-sm text-gray-800 rounded-tl-sm'
        )}>
          <p className="whitespace-pre-wrap break-words">{preview}</p>
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className={cn(
                'text-xs mt-2 font-medium',
                isOutbound ? 'text-gray-300 hover:text-white' : 'text-blue-500 hover:text-blue-700'
              )}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        {/* Reply link */}
        {onReply && item.gmail_thread_id && (
          <button
            onClick={() => onReply({ threadId: item.gmail_thread_id!, subject: item.subject || '' })}
            className="mt-1 px-1 text-[11px] text-gray-400 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            ↩ Reply in thread
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Auto-followup entry ─────────────────────────────────────────────── */
function AutoFollowupBubble({ item }: { item: Interaction & { team_member?: { name: string } } }) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = stripHtml(item.body || '');
  const isLong = cleaned.length > 220;
  const preview = isLong && !expanded ? cleaned.slice(0, 220) + '…' : cleaned;

  return (
    <div className="flex gap-2.5 flex-row-reverse group">
      <div className="h-7 w-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold mt-1 bg-amber-100 text-amber-700">
        <Zap className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[82%] flex flex-col items-end">
        <div className="flex items-baseline gap-2 mb-1 px-1 flex-row-reverse">
          <span className="text-xs font-medium text-amber-700">Auto Follow-up</span>
          <RelativeTime date={item.occurred_at} className="text-[11px] text-gray-400" />
        </div>
        <div className="rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed bg-amber-50 border border-amber-100 text-gray-800">
          <p className="whitespace-pre-wrap break-words">{preview}</p>
          {isLong && (
            <button onClick={() => setExpanded(!expanded)} className="text-xs mt-2 font-medium text-amber-600 hover:text-amber-800">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Note entry ──────────────────────────────────────────────────────── */
function NoteEntry({ item }: { item: Interaction & { team_member?: { name: string } } }) {
  return (
    <div className="flex justify-center">
      <div className="flex items-start gap-2 max-w-[85%] bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5">
        <FileText className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-amber-800">{item.team_member?.name || 'Note'}</span>
            <RelativeTime date={item.occurred_at} className="text-[11px] text-amber-600/70" />
          </div>
          <p className="text-xs text-amber-800 mt-0.5 whitespace-pre-wrap">{item.body}</p>
        </div>
      </div>
    </div>
  );
}

/* ── Stage change divider ────────────────────────────────────────────── */
function StageDivider({ text, date }: { text: string; date: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex-1 h-px bg-gray-100" />
      <div className="flex items-center gap-1.5 text-[11px] text-gray-400 flex-shrink-0">
        <ArrowRight className="h-3 w-3" />
        <span>{text}</span>
        <span className="text-gray-300">·</span>
        <RelativeTime date={date} className="text-[11px] text-gray-400" />
      </div>
      <div className="flex-1 h-px bg-gray-100" />
    </div>
  );
}

/* ── Time gap separator ──────────────────────────────────────────────── */
function TimeGap({ date }: { date: string }) {
  return (
    <div className="flex items-center justify-center py-1">
      <span className="text-[11px] text-gray-300 bg-white px-2">
        {formatDateTime(date)}
      </span>
    </div>
  );
}

/* ── Main Timeline ───────────────────────────────────────────────────── */
export function LeadTimeline({ interactions, activities, onReply }: LeadTimelineProps) {
  type Entry = {
    id: string;
    lead_id?: string;
    created_at?: string;
    _source: 'interaction' | 'activity';
    _sortKey: string;
    type: string;
    body?: string | null;
    subject?: string | null;
    occurred_at: string;
    gmail_thread_id?: string | null;
    gmail_message_id?: string | null;
    team_member?: { name: string };
    metadata?: Record<string, unknown>;
  };

  const entries: Entry[] = [
    ...interactions.map(i => ({ ...i, _source: 'interaction' as const, _sortKey: i.occurred_at })),
    ...activities
      .filter(a => !['lead_created', 'lead_updated'].includes(a.action))
      .map(a => ({
        id: a.id,
        occurred_at: a.created_at,
        type: 'stage_change' as const,
        body: formatActivityText(a),
        _source: 'activity' as const,
        _sortKey: a.created_at,
        team_member: a.team_member as { name: string } | undefined,
        metadata: {} as Record<string, unknown>,
      })),
  ].sort((a, b) => new Date(a._sortKey).getTime() - new Date(b._sortKey).getTime());

  if (entries.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="h-10 w-10 rounded-full bg-gray-50 flex items-center justify-center mx-auto mb-3">
          <FileText className="h-5 w-5 text-gray-300" />
        </div>
        <p className="text-sm text-gray-400">No activity yet</p>
        <p className="text-xs text-gray-300 mt-1">Sync Gmail or add a note to start</p>
      </div>
    );
  }

  // Show a time-gap separator when consecutive emails are >4h apart
  const GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000;

  return (
    <div className="flex flex-col gap-3 py-2">
      {entries.map((entry, idx) => {
        const isOutbound = entry.type === 'email_outbound';
        const isInbound = entry.type === 'email_inbound';
        const isEmail = isOutbound || isInbound;
        const isStageChange = entry.type === 'stage_change';
        const isNote = entry.type === 'note';
        const isAutoFollowup = entry.type === 'follow_up_auto' || !!(entry.metadata as Record<string, unknown>)?.auto_followup;

        // Time gap detection
        const prev = entries[idx - 1];
        const showGap = prev && isEmail &&
          (new Date(entry._sortKey).getTime() - new Date(prev._sortKey).getTime()) > GAP_THRESHOLD_MS;

        return (
          <div key={`${entry._source}-${entry.id}`}>
            {showGap && <TimeGap date={entry.occurred_at} />}
            {isStageChange && <StageDivider text={entry.body || ''} date={entry.occurred_at} />}
            {isNote && <NoteEntry item={entry as unknown as Interaction & { team_member?: { name: string } }} />}
            {isAutoFollowup && <AutoFollowupBubble item={entry as unknown as Interaction & { team_member?: { name: string } }} />}
            {isEmail && !isAutoFollowup && (
              <EmailBubble
                item={entry as unknown as Interaction & { team_member?: { name: string } }}
                isOutbound={isOutbound}
                onReply={onReply}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
