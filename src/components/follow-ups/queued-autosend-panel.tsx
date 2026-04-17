'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Zap, X, Clock, ExternalLink } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import { buildGmailThreadUrl } from '@/lib/gmail/url';
import type { FollowUp } from '@/types';

function formatCountdown(iso: string, now: number): string {
  const target = new Date(iso).getTime();
  const delta = target - now;
  if (delta <= 0) return 'sending any moment';
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return `in ${Math.max(1, Math.floor(delta / 1000))}s`;
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs ? `in ${days}d ${remHrs}h` : `in ${days}d`;
}

function imminence(iso: string, now: number): 'soon' | 'near' | 'later' {
  const mins = (new Date(iso).getTime() - now) / 60_000;
  if (mins <= 15) return 'soon';
  if (mins <= 60) return 'near';
  return 'later';
}

export function QueuedAutoSendPanel() {
  const { user } = useSession();
  const [items, setItems] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const fetchQueue = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/follow-ups?queue=auto_send', {
        headers: { 'x-team-member-id': user.team_member_id },
      });
      const data = await res.json();
      setItems(data.follow_ups || []);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  // Refresh queue every 60s + tick clock every 30s for live countdowns
  useEffect(() => {
    const fetchI = setInterval(fetchQueue, 60_000);
    const tickI = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(fetchI); clearInterval(tickI); };
  }, [fetchQueue]);

  const handleExclude = async (id: string) => {
    if (!user) return;
    const prev = items;
    setItems(items.filter(i => i.id !== id));
    try {
      const res = await fetch(`/api/follow-ups/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': user.team_member_id,
        },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Excluded from auto-send');
    } catch {
      setItems(prev);
      toast.error('Failed to exclude');
    }
  };

  return (
    <aside className="w-full lg:w-[340px] lg:flex-shrink-0">
      <div className="sticky top-[calc(var(--topnav-height)+20px)] card p-4">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="h-4 w-4 text-amber-500" weight="fill" />
          <h2 className="text-sm font-semibold text-gray-900">Auto-send queue</h2>
          {items.length > 0 && (
            <span className="ml-auto text-xs text-gray-400">{items.length}</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Drafted and waiting for the cron to send. Soonest first.
        </p>

        {loading ? (
          <div className="text-xs text-gray-400 py-8 text-center">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            <Clock className="h-8 w-8 mx-auto mb-2 text-gray-200" />
            <p className="text-xs font-medium text-gray-600">Nothing queued.</p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Replies or manual sends auto-cancel queued drafts.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {items.map(f => {
              const when = f.scheduled_for || f.due_at;
              const urgency = imminence(when, now);
              const barColor =
                urgency === 'soon' ? 'bg-red-500'
                : urgency === 'near' ? 'bg-amber-500'
                : 'bg-gray-300';
              return (
                <li
                  key={f.id}
                  className="relative pl-3 pr-2 py-2.5 rounded-[var(--radius-soft)] border border-gray-100 bg-white hover:border-gray-200 transition-colors"
                >
                  <div className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r ${barColor}`} />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/leads/${f.lead?.id ?? f.lead_id}`}
                        className="block text-sm font-medium text-gray-900 truncate hover:text-blue-600"
                      >
                        {f.lead?.contact_name || '—'}
                      </Link>
                      <p className="text-[11px] text-gray-400 truncate">
                        {f.lead?.company_name || ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {(() => {
                        const url = buildGmailThreadUrl(f.gmail_thread_id, user?.name);
                        return url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open thread in Gmail"
                            className="text-gray-300 hover:text-blue-600 transition-colors p-0.5"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null;
                      })()}
                      <button
                        onClick={() => handleExclude(f.id)}
                        title="Exclude from auto-send"
                        className="text-gray-300 hover:text-red-500 transition-colors p-0.5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {f.suggested_message && (
                    <p className="text-[11px] text-gray-500 line-clamp-2 mt-1 italic">
                      &ldquo;{f.suggested_message.split('\n')[0]}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <Clock className="h-3 w-3 text-gray-400" />
                    <span className={`text-[11px] font-medium ${
                      urgency === 'soon' ? 'text-red-600'
                      : urgency === 'near' ? 'text-amber-600'
                      : 'text-gray-500'
                    }`}>
                      {formatCountdown(when, now)}
                    </span>
                    {f.assigned_member?.name && (
                      <span className="text-[11px] text-gray-400 ml-auto">
                        as {f.assigned_member.name.split(' ')[0]}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
