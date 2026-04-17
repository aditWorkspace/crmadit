'use client';

import { CalendarEvent } from './availability-grid';
import { Video, BookOpen, Clock } from '@/lib/icons';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface UpcomingCallsProps {
  events: CalendarEvent[];
}

function formatTimePT(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function Countdown({ targetIso }: { targetIso: string }) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    const update = () => {
      const mins = Math.round((new Date(targetIso).getTime() - Date.now()) / 60000);
      if (mins <= 0) setLabel('Now');
      else if (mins < 60) setLabel(`in ${mins}m`);
      else setLabel(`in ${Math.floor(mins / 60)}h ${mins % 60}m`);
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, [targetIso]);

  return <span className="text-xs font-medium text-blue-600">{label}</span>;
}

export function UpcomingCalls({ events }: UpcomingCallsProps) {
  const now = new Date();
  const todayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // Filter to today's non-personal events that haven't ended yet
  const upcoming = events
    .filter(ev => {
      const evDateKey = new Date(ev.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      return evDateKey === todayKey
        && new Date(ev.end) > now
        && ev.meetingType !== 'personal';
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 3);

  if (upcoming.length === 0) return null;

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-4 mb-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Clock className="h-4 w-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-blue-900">Today&apos;s Calls</h3>
      </div>
      <div className="space-y-2">
        {upcoming.map(ev => (
          <div key={ev.id} className="flex items-center justify-between bg-white rounded-lg border border-blue-100 px-3 py-2">
            <div className="flex items-center gap-3 min-w-0">
              <div className="text-right min-w-[60px]">
                <p className="text-xs font-medium text-gray-700">{formatTimePT(ev.start)}</p>
                <Countdown targetIso={ev.start} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{ev.summary}</p>
                {ev.leadName && (
                  <p className="text-xs text-gray-500 truncate">{ev.leadName}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {ev.meetLink && (
                <a
                  href={ev.meetLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-white bg-green-600 hover:bg-green-700 rounded px-2.5 py-1.5 transition-colors"
                >
                  <Video className="h-3 w-3" />
                  Join
                </a>
              )}
              {ev.leadId && (
                <Link
                  href={`/leads/${ev.leadId}`}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1.5"
                >
                  <BookOpen className="h-3 w-3" />
                  Prep
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
