'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { StageBadge } from '@/components/leads/stage-badge';
import { EmailComposeModal } from '@/components/leads/email-compose-modal';
import { cn, formatDate } from '@/lib/utils';
import { LeadStage } from '@/types';
import Link from 'next/link';
import {
  Loader2, Mail, ArrowLeft, Reply, ExternalLink,
  ChevronDown, Check,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────

interface ThreadMessage {
  id: string;
  type: 'email_inbound' | 'email_outbound';
  subject: string | null;
  body: string | null;
  summary: string | null;
  occurred_at: string;
  team_member: { id: string; name: string } | null;
}

interface EmailThread {
  thread_id: string;
  latest_at: string;
  latest_subject: string;
  latest_type: string;
  needs_reply: boolean;
  message_count: number;
  inbound_count: number;
  lead: {
    id: string;
    contact_name: string;
    company_name: string;
    contact_email: string;
    stage: string;
    owned_by: string;
  } | null;
  messages: ThreadMessage[];
}

interface TeamMember {
  id: string;
  name: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const OWNER_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  Adit:   { bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-500' },
  Srijay: { bg: 'bg-purple-100',  text: 'text-purple-700',  dot: 'bg-purple-500' },
  Asim:   { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
};

const DEFAULT_OWNER_COLOR = { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' };

function ownerColor(name: string) {
  return OWNER_COLORS[name] || DEFAULT_OWNER_COLOR;
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Component ──────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'needs_reply';
type StageFilter = 'all' | 'replied' | 'scheduling' | 'scheduled' | 'call_completed';
type SortOrder = 'newest' | 'oldest';

const STAGE_FILTER_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: 'all', label: 'All stages' },
  { value: 'replied', label: 'In Dialogue' },
  { value: 'scheduling', label: 'Scheduling' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'call_completed', label: 'Call Done' },
];

export function EmailsTab() {
  const { user } = useSession();
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [sort, setSort] = useState<SortOrder>('newest');
  const [selectedThread, setSelectedThread] = useState<EmailThread | null>(null);
  const [replyThread, setReplyThread] = useState<EmailThread | null>(null);
  const [handledThreads, setHandledThreads] = useState<Set<string>>(() => new Set());

  const fetchData = useCallback(async () => {
    if (!user) return;
    const headers = { 'x-team-member-id': user.team_member_id };
    const params = new URLSearchParams();
    if (statusFilter === 'needs_reply') params.set('status', 'needs_reply');
    if (ownerFilter !== 'all') params.set('owner', ownerFilter);
    if (sort === 'oldest') params.set('sort', 'oldest');

    const [inboxRes, membersRes] = await Promise.all([
      fetch(`/api/inbox?${params}`, { headers }),
      members.length > 0 ? null : fetch('/api/team/members'),
    ]);

    if (inboxRes.ok) {
      const data = await inboxRes.json();
      setThreads(data.threads || []);
    }
    if (membersRes?.ok) {
      const data = await membersRes.json();
      setMembers(data.members || []);
    }
    setLoading(false);
  }, [user, statusFilter, ownerFilter, sort, members.length]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const memberName = (id: string) => members.find(m => m.id === id)?.name || '?';
  // Client-side stage filter (API already returns stage in lead object)
  const filteredThreads = stageFilter === 'all'
    ? threads
    : threads.filter(t => t.lead?.stage === stageFilter);
  const needsReplyCount = filteredThreads.filter(t => t.needs_reply && !handledThreads.has(t.thread_id)).length;

  const handleMarkHandled = (threadId: string) => {
    setHandledThreads(prev => new Set(prev).add(threadId));
  };

  // ── Thread detail view ────────────────────────────────────────────
  if (selectedThread) {
    const thread = selectedThread;
    const owner = thread.lead ? memberName(thread.lead.owned_by) : '';
    const oc = ownerColor(owner);
    const msgs = [...thread.messages].reverse(); // oldest first

    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-gray-100 px-6 py-4">
          <button
            onClick={() => setSelectedThread(null)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to inbox
          </button>
          <div className="flex items-center gap-3">
            <div className={cn('h-2 w-2 rounded-full flex-shrink-0', oc.dot)} />
            <h2 className="text-lg font-semibold text-gray-900">
              {thread.lead?.contact_name || 'Unknown'}
            </h2>
            <span className="text-sm text-gray-400">{thread.lead?.company_name}</span>
            {thread.lead && <StageBadge stage={thread.lead.stage as LeadStage} />}
            <span className={cn('text-xs px-2 py-0.5 rounded-full', oc.bg, oc.text)}>{owner}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">{thread.latest_subject}</p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {msgs.map(msg => (
            <div
              key={msg.id}
              className={cn(
                'rounded-lg border p-4',
                msg.type === 'email_inbound'
                  ? 'bg-white border-gray-200'
                  : 'bg-blue-50/60 border-blue-100'
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-sm font-medium',
                    msg.type === 'email_inbound' ? 'text-gray-800' : 'text-blue-800'
                  )}>
                    {msg.type === 'email_inbound'
                      ? thread.lead?.contact_name || 'Prospect'
                      : msg.team_member?.name || 'Us'}
                  </span>
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full',
                    msg.type === 'email_inbound'
                      ? 'bg-gray-100 text-gray-500'
                      : 'bg-blue-100 text-blue-600'
                  )}>
                    {msg.type === 'email_inbound' ? 'Inbound' : 'Outbound'}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{formatDate(msg.occurred_at)}</span>
              </div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {msg.body || msg.summary || '(no content)'}
              </div>
            </div>
          ))}
        </div>

        {/* Action bar */}
        <div className="flex-shrink-0 border-t border-gray-100 px-6 py-3 flex items-center gap-3">
          {thread.lead && (
            <button
              onClick={() => setReplyThread(thread)}
              className="flex items-center gap-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
            >
              <Reply className="h-4 w-4" />
              Reply
            </button>
          )}
          {thread.lead && (
            <Link
              href={`/leads/${thread.lead.id}`}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg px-4 py-2 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View Lead
            </Link>
          )}
          {thread.needs_reply && !handledThreads.has(thread.thread_id) && (
            <button
              onClick={() => handleMarkHandled(thread.thread_id)}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-4 py-2 transition-colors"
            >
              <Check className="h-3.5 w-3.5" />
              Mark Handled
            </button>
          )}
        </div>

        {/* Reply modal */}
        {replyThread && replyThread.lead && user && (
          <EmailComposeModal
            leadId={replyThread.lead.id}
            threadId={replyThread.thread_id}
            toEmail={replyThread.lead.contact_email}
            subject={replyThread.latest_subject.startsWith('Re:') ? replyThread.latest_subject : `Re: ${replyThread.latest_subject}`}
            teamMemberId={user.team_member_id}
            ownerMemberId={replyThread.lead.owned_by}
            contactName={replyThread.lead.contact_name}
            companyName={replyThread.lead.company_name}
            onClose={() => setReplyThread(null)}
            onSent={() => { setReplyThread(null); setSelectedThread(null); fetchData(); }}
          />
        )}
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex-shrink-0 flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStatusFilter('all')}
            className={cn(
              'text-xs px-3 py-1.5 rounded-full border transition-colors',
              statusFilter === 'all' ? 'bg-gray-900 text-white border-gray-900' : 'text-gray-500 border-gray-200 hover:border-gray-300'
            )}
          >
            All
          </button>
          <button
            onClick={() => setStatusFilter('needs_reply')}
            className={cn(
              'text-xs px-3 py-1.5 rounded-full border transition-colors',
              statusFilter === 'needs_reply' ? 'bg-red-600 text-white border-red-600' : 'text-gray-500 border-gray-200 hover:border-gray-300'
            )}
          >
            Needs Response {needsReplyCount > 0 && `(${needsReplyCount})`}
          </button>

          {/* Owner filter */}
          <div className="relative ml-2">
            <select
              value={ownerFilter}
              onChange={e => { setOwnerFilter(e.target.value); setLoading(true); }}
              className="text-xs text-gray-600 border border-gray-200 rounded-full px-3 py-1.5 pr-7 appearance-none bg-white cursor-pointer hover:border-gray-300 transition-colors"
            >
              <option value="all">All owners</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
          </div>

          {/* Stage filter */}
          <div className="relative">
            <select
              value={stageFilter}
              onChange={e => setStageFilter(e.target.value as StageFilter)}
              className="text-xs text-gray-600 border border-gray-200 rounded-full px-3 py-1.5 pr-7 appearance-none bg-white cursor-pointer hover:border-gray-300 transition-colors"
            >
              {STAGE_FILTER_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={sort}
            onChange={e => { setSort(e.target.value as SortOrder); setLoading(true); }}
            className="text-xs text-gray-500 border border-gray-200 rounded-full px-3 py-1.5 pr-7 appearance-none bg-white cursor-pointer hover:border-gray-300 transition-colors"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <span className="text-xs text-gray-400">{filteredThreads.length} threads</span>
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading emails...
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-2">
            <Mail className="h-8 w-8" />
            <p className="text-sm">
              {statusFilter === 'needs_reply' ? 'No threads need a response.' : 'No email threads found.'}
            </p>
          </div>
        ) : (
          <div>
            {filteredThreads.map(thread => {
              const owner = thread.lead ? memberName(thread.lead.owned_by) : '';
              const oc = ownerColor(owner);
              const isHandled = handledThreads.has(thread.thread_id);
              const showNeedsReply = thread.needs_reply && !isHandled;
              const snippet = thread.messages[0]?.summary || thread.messages[0]?.body?.slice(0, 100) || '';

              return (
                <div
                  key={thread.thread_id}
                  onClick={() => setSelectedThread(thread)}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3 border-b border-gray-50 cursor-pointer transition-colors hover:bg-gray-50',
                    showNeedsReply && 'bg-red-50/20'
                  )}
                >
                  {/* Owner dot */}
                  <div className={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', oc.dot)} />

                  {/* Contact + company */}
                  <div className="w-[180px] flex-shrink-0 min-w-0">
                    <span className={cn(
                      'text-sm truncate block',
                      showNeedsReply ? 'font-semibold text-gray-900' : 'text-gray-700'
                    )}>
                      {thread.lead?.contact_name || 'Unknown'}
                    </span>
                    <span className="text-xs text-gray-400 truncate block">
                      {thread.lead?.company_name || ''}
                    </span>
                  </div>

                  {/* Subject + snippet */}
                  <div className="flex-1 min-w-0 mr-3">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-sm truncate',
                        showNeedsReply ? 'font-semibold text-gray-900' : 'text-gray-700'
                      )}>
                        {thread.latest_subject}
                      </span>
                      <span className="text-xs text-gray-400 truncate hidden lg:inline">
                        {snippet}
                      </span>
                    </div>
                  </div>

                  {/* Tags */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Owner tag */}
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', oc.bg, oc.text)}>
                      {owner}
                    </span>

                    {/* Response status tag */}
                    {showNeedsReply ? (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-700 cursor-pointer hover:bg-red-200 transition-colors"
                        onClick={e => { e.stopPropagation(); handleMarkHandled(thread.thread_id); }}
                        title="Click to mark as handled"
                      >
                        Them
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                        Us
                      </span>
                    )}

                    {/* Stage badge */}
                    {thread.lead && <StageBadge stage={thread.lead.stage as LeadStage} className="text-[10px] px-1.5 py-0" />}

                    {/* Message count */}
                    {thread.message_count > 1 && (
                      <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                        {thread.message_count}
                      </span>
                    )}
                  </div>

                  {/* Date */}
                  <span className="text-xs text-gray-400 flex-shrink-0 w-16 text-right">
                    {relativeDate(thread.latest_at)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reply modal (from list view — in case we add quick-reply later) */}
      {replyThread && replyThread.lead && user && (
        <EmailComposeModal
          leadId={replyThread.lead.id}
          threadId={replyThread.thread_id}
          toEmail={replyThread.lead.contact_email}
          subject={replyThread.latest_subject.startsWith('Re:') ? replyThread.latest_subject : `Re: ${replyThread.latest_subject}`}
          teamMemberId={user.team_member_id}
          contactName={replyThread.lead.contact_name}
          companyName={replyThread.lead.company_name}
          onClose={() => setReplyThread(null)}
          onSent={() => { setReplyThread(null); fetchData(); }}
        />
      )}
    </div>
  );
}
