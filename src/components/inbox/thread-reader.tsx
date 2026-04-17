'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ownerColor } from '@/lib/colors';
import { STAGE_LABELS, STAGE_COLORS } from '@/lib/constants';
import type { LeadStage } from '@/types';
import { useSession } from '@/hooks/use-session';
import { useThreadDetail } from '@/hooks/use-thread-detail';
import { useThreadReadState } from '@/hooks/use-thread-read-state';
import { Clock, Trash2, ExternalLink, Loader2, Mail } from '@/lib/icons';
import { MessageCard } from './message-card';
import { InlineComposer } from './inline-composer';
import { ThreadComments } from './thread-comments';

interface ThreadReaderProps {
  threadId: string;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  onArchiveLocal?: (threadId: string) => void;
  onMarkUnreadLocal?: (threadId: string) => void;
  onRefresh?: () => void;
  registerFocusComposer?: (fn: () => void) => void;
}

export function ThreadReader({
  threadId,
  composerOpen,
  onComposerOpenChange,
  onArchiveLocal,
  onMarkUnreadLocal,
  onRefresh,
  registerFocusComposer,
}: ThreadReaderProps) {
  const { user } = useSession();
  const { detail, loading, refresh } = useThreadDetail(threadId);
  const { markUnread } = useThreadReadState();
  const [archiving, setArchiving] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Expose a way for the parent to pop the composer (triggered by 'r' hotkey).
  useEffect(() => {
    if (!registerFocusComposer) return;
    registerFocusComposer(() => onComposerOpenChange(true));
  }, [registerFocusComposer, onComposerOpenChange]);

  // Scroll to bottom on new thread
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [threadId, detail?.messages.length]);

  const handleArchive = useCallback(async () => {
    if (!user) return;
    setArchiving(true);
    try {
      const res = await fetch(
        `/api/inbox/threads/${encodeURIComponent(threadId)}/archive`,
        {
          method: 'POST',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      if (!res.ok) {
        toast.error('Failed to archive thread');
        return;
      }
      toast.success('Archived');
      onArchiveLocal?.(threadId);
      onRefresh?.();
    } catch {
      toast.error('Failed to archive thread');
    } finally {
      setArchiving(false);
    }
  }, [user, threadId, onArchiveLocal, onRefresh]);

  const handleSnooze = () => {
    // Hand off to Lane F via custom event.
    window.dispatchEvent(
      new CustomEvent('inbox:open-snooze', { detail: { threadId } })
    );
  };

  const handleMarkUnread = async () => {
    if (!user) return;
    await markUnread(threadId);
    toast.success('Marked as unread');
    onMarkUnreadLocal?.(threadId);
    onRefresh?.();
  };

  if (loading && !detail) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[color:var(--surface-muted)]/40">
        <Mail className="h-8 w-8 text-gray-300 mb-3" />
        <p className="text-sm text-gray-500">Thread not found.</p>
      </div>
    );
  }

  const lead = detail.lead;
  const ownerName = null; // We don't join owner name in detail response — keep dot neutral.
  const oc = ownerColor(ownerName);
  const stage = (lead?.stage as LeadStage | null) ?? null;
  const subjectForReply = detail.latest_subject.startsWith('Re:')
    ? detail.latest_subject
    : `Re: ${detail.latest_subject}`;

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-white">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-[color:var(--border-subtle)] px-5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn('h-2 w-2 rounded-full flex-shrink-0', oc.dot)}
                aria-hidden
              />
              <h2 className="truncate text-base font-semibold text-gray-900">
                {detail.latest_subject}
              </h2>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              {lead ? (
                <Link
                  href={`/leads/${lead.id}`}
                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800"
                >
                  <span className="font-medium">
                    {lead.contact_name || lead.contact_email || 'Lead'}
                  </span>
                  {lead.company_name && (
                    <span className="text-gray-400">· {lead.company_name}</span>
                  )}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              ) : (
                <span className="text-gray-400">Not linked to a lead</span>
              )}
              {stage && (
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-medium',
                    STAGE_COLORS[stage]
                  )}
                >
                  {STAGE_LABELS[stage]}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <div data-slot="thread-header-right" className="flex items-center" />
            <button
              type="button"
              data-action="snooze-trigger"
              data-thread-id={threadId}
              onClick={handleSnooze}
              className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              title="Snooze (S)"
            >
              <Clock className="h-3.5 w-3.5" />
              Snooze
            </button>
            <button
              type="button"
              onClick={handleMarkUnread}
              className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              title="Mark unread (U)"
            >
              Unread
            </button>
            <button
              type="button"
              onClick={handleArchive}
              disabled={archiving}
              className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
              title="Archive (E)"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Archive
            </button>
          </div>
        </div>
      </div>

      {/* Messages scroller */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
      >
        {[...detail.messages].reverse().map(msg => (
          <MessageCard
            key={msg.id}
            message={msg}
            leadContactName={lead?.contact_name ?? null}
          />
        ))}
      </div>

      {/* Inline composer */}
      {user && (
        <InlineComposer
          threadId={threadId}
          subject={subjectForReply}
          lead={lead}
          teamMemberId={user.team_member_id}
          expanded={composerOpen}
          onExpandedChange={onComposerOpenChange}
          onSent={() => {
            refresh();
            onRefresh?.();
          }}
        />
      )}

      {/* Lane G mount point — thread comments + presence */}
      <div data-slot="thread-comments" id="thread-comments-slot"><ThreadComments threadId={threadId} /></div>
    </div>
  );
}
