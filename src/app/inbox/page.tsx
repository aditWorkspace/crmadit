'use client';

import { useState, useEffect } from 'react';
import { useSession } from '@/hooks/use-session';
import { StageBadge } from '@/components/leads/stage-badge';
import { EmailComposeModal } from '@/components/leads/email-compose-modal';
import { Loader2, Mail, MessageCircle, ChevronDown, ChevronRight, Reply } from 'lucide-react';
import Link from 'next/link';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { LeadStage } from '@/types';

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
  lead: { id: string; contact_name: string; company_name: string; contact_email: string; stage: string; owned_by: string } | null;
  messages: ThreadMessage[];
}

export default function InboxPage() {
  const { user } = useSession();
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'needs_reply'>('all');
  const [replyThread, setReplyThread] = useState<EmailThread | null>(null);

  const fetchInbox = async () => {
    if (!user) return;
    const res = await fetch('/api/inbox', {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      const data = await res.json();
      setThreads(data.threads || []);
    }
    setLoading(false);
  };

  useEffect(() => { fetchInbox(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = filter === 'needs_reply' ? threads.filter(t => t.needs_reply) : threads;
  const needsReplyCount = threads.filter(t => t.needs_reply).length;

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-8 py-5 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Team Inbox</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {threads.length} threads{needsReplyCount > 0 && ` \u00b7 ${needsReplyCount} need reply`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFilter('all')}
              className={cn(
                'text-xs px-3 py-1.5 rounded-full border transition-colors',
                filter === 'all' ? 'bg-gray-900 text-white border-gray-900' : 'text-gray-500 border-gray-200 hover:border-gray-300'
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilter('needs_reply')}
              className={cn(
                'text-xs px-3 py-1.5 rounded-full border transition-colors',
                filter === 'needs_reply' ? 'bg-amber-600 text-white border-amber-600' : 'text-gray-500 border-gray-200 hover:border-gray-300'
              )}
            >
              Needs Reply {needsReplyCount > 0 && `(${needsReplyCount})`}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-2">
            <Mail className="h-8 w-8" />
            <p className="text-sm">{filter === 'needs_reply' ? 'No threads need a reply right now.' : 'No email threads yet.'}</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(thread => {
              const isExpanded = expandedThread === thread.thread_id;
              return (
                <div key={thread.thread_id}>
                  {/* Thread header row */}
                  <div
                    className={cn(
                      'flex items-start gap-4 px-8 py-4 cursor-pointer hover:bg-gray-50 transition-colors',
                      thread.needs_reply && 'bg-amber-50/30'
                    )}
                    onClick={() => setExpandedThread(isExpanded ? null : thread.thread_id)}
                  >
                    <div className="flex items-center gap-1.5 flex-shrink-0 pt-1 text-gray-400">
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      <MessageCircle className={cn('h-4 w-4', thread.needs_reply ? 'text-amber-500' : 'text-gray-300')} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {thread.lead?.contact_name || 'Unknown'}
                          </span>
                          <span className="text-xs text-gray-400">{thread.lead?.company_name}</span>
                          {thread.lead && <StageBadge stage={thread.lead.stage as LeadStage} />}
                          {thread.needs_reply && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-[1px] rounded-full font-medium">
                              Needs reply
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-[1px] rounded-full">
                            {thread.message_count} msg{thread.message_count !== 1 && 's'}
                          </span>
                          <span className="text-xs text-gray-400">{formatDate(thread.latest_at)}</span>
                        </div>
                      </div>
                      <p className="text-sm text-gray-700 truncate">{thread.latest_subject}</p>
                    </div>
                  </div>

                  {/* Expanded: message list + reply button */}
                  {isExpanded && (
                    <div className="bg-gray-50/50 border-t border-gray-100 px-12 py-3 space-y-3">
                      {[...thread.messages].reverse().map(msg => (
                        <div key={msg.id} className={cn(
                          'rounded-lg p-3 text-sm',
                          msg.type === 'email_inbound'
                            ? 'bg-white border border-gray-200'
                            : 'bg-blue-50 border border-blue-100'
                        )}>
                          <div className="flex items-center justify-between mb-1">
                            <span className={cn(
                              'text-xs font-medium',
                              msg.type === 'email_inbound' ? 'text-gray-700' : 'text-blue-700'
                            )}>
                              {msg.type === 'email_inbound' ? thread.lead?.contact_name : (msg.team_member?.name || 'Us')}
                            </span>
                            <span className="text-[10px] text-gray-400">{formatDate(msg.occurred_at)}</span>
                          </div>
                          <p className="text-xs text-gray-600 whitespace-pre-wrap">
                            {msg.summary || msg.body?.slice(0, 500) || ''}
                          </p>
                        </div>
                      ))}

                      {/* Reply + View Lead buttons */}
                      <div className="flex items-center gap-2 pt-1">
                        {thread.lead && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setReplyThread(thread); }}
                            className="flex items-center gap-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded px-3 py-1.5 transition-colors"
                          >
                            <Reply className="h-3 w-3" />
                            Reply
                          </button>
                        )}
                        {thread.lead && (
                          <Link
                            href={`/leads/${thread.lead.id}`}
                            className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-3 py-1.5"
                          >
                            View Lead
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Inline reply modal */}
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
          onSent={() => { setReplyThread(null); fetchInbox(); }}
        />
      )}
    </div>
  );
}
