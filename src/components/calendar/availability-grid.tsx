'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { format, addDays, isToday } from 'date-fns';
import { cn } from '@/lib/utils';
import { Video, ExternalLink, User, Building2, Clock } from 'lucide-react';
import Link from 'next/link';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isProxi: boolean;
  meetLink?: string | null;
  htmlLink?: string | null;
  attendees?: string[];
  leadId?: string | null;
  leadName?: string | null;
  meetingType?: 'discovery' | 'followup' | 'internal' | 'personal';
}

interface AvailabilityGridProps {
  slots: Slot[];
  weekStart: Date;
  connectedCount: number;
  events?: CalendarEvent[];
  view?: 'week' | 'day';
  selectedDay?: Date;
  onBlockTime?: (start: string, end: string) => void;
}

// PT hours to display: 8am–8pm = 24 half-hour rows
const START_HOUR = 8;
const END_HOUR = 20;

function getPTHour(iso: string): number {
  return parseInt(
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: false,
    })
  );
}

function getPTMinute(iso: string): number {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    minute: '2-digit',
  }) === '00' ? 0 : 30;
}

function getDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function roundDownToSlot(iso: string): string {
  const h = getPTHour(iso);
  const dateKey = getDateKey(iso);
  const ptMin = getPTMinute(iso);
  return `${dateKey}:${String(h).padStart(2, '0')}:${ptMin === 0 ? '00' : '30'}`;
}

function eventSlotCount(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.ceil(ms / (30 * 60 * 1000)));
}

function formatTimePT(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function minutesUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60);
}

interface EventSlotInfo {
  event: CalendarEvent;
  isFirstSlot: boolean;
  spanCount: number;
}

// Meeting type colors
const MEETING_TYPE_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  discovery: { bg: 'bg-indigo-500', border: 'border-indigo-400', text: 'text-white', label: 'Discovery' },
  followup: { bg: 'bg-teal-500', border: 'border-teal-400', text: 'text-white', label: 'Follow-up' },
  internal: { bg: 'bg-purple-500', border: 'border-purple-400', text: 'text-white', label: 'Internal' },
  personal: { bg: 'bg-gray-300', border: 'border-gray-200', text: 'text-gray-700', label: 'Personal' },
};

const NON_PROXI_BUSY: Record<number, string> = {
  0: 'bg-emerald-50 border-emerald-100',
  1: 'bg-amber-100 border-amber-200',
  2: 'bg-orange-200 border-orange-300',
  3: 'bg-red-300 border-red-400',
};

// Popover component for event details
function EventPopover({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const colors = MEETING_TYPE_COLORS[event.meetingType ?? 'personal'];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const externalAttendees = (event.attendees ?? []).filter(
    e => !['aditmittal@berkeley.edu', 'srijay@proxi.ai', 'asim@proxi.ai'].includes(e)
  );

  return (
    <div
      ref={ref}
      className="absolute z-50 bg-white rounded-lg shadow-lg border border-gray-200 p-3 w-64 text-left"
      style={{ top: '100%', left: '50%', transform: 'translateX(-50%)' }}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', colors.bg, colors.text)}>
          {colors.label}
        </span>
      </div>
      <p className="text-sm font-semibold text-gray-900 mb-1 truncate">{event.summary}</p>
      <div className="flex items-center gap-1 text-xs text-gray-500 mb-2">
        <Clock className="h-3 w-3" />
        <span>{formatTimePT(event.start)} – {formatTimePT(event.end)}</span>
      </div>

      {externalAttendees.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] font-medium text-gray-400 uppercase mb-0.5">Attendees</p>
          {externalAttendees.slice(0, 4).map(email => (
            <div key={email} className="flex items-center gap-1 text-xs text-gray-600">
              <User className="h-3 w-3 text-gray-400" />
              <span className="truncate">{email}</span>
            </div>
          ))}
          {externalAttendees.length > 4 && (
            <span className="text-[10px] text-gray-400">+{externalAttendees.length - 4} more</span>
          )}
        </div>
      )}

      {event.leadId && (
        <Link
          href={`/leads/${event.leadId}`}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 mb-2"
        >
          <Building2 className="h-3 w-3" />
          <span>View lead: {event.leadName}</span>
        </Link>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
        {event.meetLink && (
          <a
            href={event.meetLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-white bg-green-600 hover:bg-green-700 rounded px-2 py-1 transition-colors"
          >
            <Video className="h-3 w-3" />
            Join Meet
          </a>
        )}
        {event.htmlLink && (
          <a
            href={event.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
          >
            <ExternalLink className="h-3 w-3" />
            Calendar
          </a>
        )}
      </div>
    </div>
  );
}

export function AvailabilityGrid({
  slots,
  weekStart,
  connectedCount,
  events = [],
  view = 'week',
  selectedDay,
  onBlockTime,
}: AvailabilityGridProps) {
  const [popoverEvent, setPopoverEvent] = useState<CalendarEvent | null>(null);
  const [popoverKey, setPopoverKey] = useState<string | null>(null);

  const days = view === 'day' && selectedDay
    ? [selectedDay]
    : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const colTemplate = view === 'day'
    ? 'grid-cols-[72px_1fr]'
    : 'grid-cols-[72px_repeat(7,1fr)]';

  // Build busy-count lookup
  const slotMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of slots) {
      const h = getPTHour(s.start);
      const m = getPTMinute(s.start);
      if (h >= START_HOUR && h < END_HOUR) {
        const key = `${getDateKey(s.start)}:${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`;
        map[key] = s.busyCount;
      }
    }
    return map;
  }, [slots]);

  // Build event slot lookup
  const eventSlotMap = useMemo(() => {
    const map: Record<string, EventSlotInfo> = {};
    for (const ev of events) {
      if (!ev.start || !ev.end) continue;
      const totalSpan = eventSlotCount(ev.start, ev.end);
      const evStart = new Date(ev.start);
      const evEnd = new Date(ev.end);
      const cursor = new Date(evStart);
      const ptMin = getPTMinute(evStart.toISOString());
      cursor.setMinutes(ptMin, 0, 0);
      let slotIndex = 0;
      while (cursor < evEnd) {
        const h = getPTHour(cursor.toISOString());
        if (h >= START_HOUR && h < END_HOUR) {
          const key = roundDownToSlot(cursor.toISOString());
          if (!map[key]) {
            map[key] = { event: ev, isFirstSlot: slotIndex === 0, spanCount: totalSpan };
          }
        }
        cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
        slotIndex++;
      }
      // Ensure first slot is marked
      const firstKey = roundDownToSlot(evStart.toISOString());
      if (!map[firstKey]) {
        const h = getPTHour(evStart.toISOString());
        if (h >= START_HOUR && h < END_HOUR) {
          map[firstKey] = { event: ev, isFirstSlot: true, spanCount: totalSpan };
        }
      }
    }
    return map;
  }, [events]);

  const timeRows = useMemo(() => {
    const rows: { label: string; hour: number; minute: number }[] = [];
    for (let h = START_HOUR; h < END_HOUR; h++) {
      rows.push({ label: format(new Date(2020, 0, 1, h, 0), 'h:mm a'), hour: h, minute: 0 });
      rows.push({ label: '', hour: h, minute: 30 });
    }
    return rows;
  }, []);

  const handleEmptySlotClick = (dateKey: string, hour: number, minute: number) => {
    if (!onBlockTime) return;
    // Build ISO start/end for a 30-min block
    const d = new Date(`${dateKey}T${String(hour).padStart(2, '0')}:${minute === 0 ? '00' : '30'}:00`);
    // Convert to PT-aware ISO
    const startISO = d.toISOString();
    const endISO = new Date(d.getTime() + 30 * 60 * 1000).toISOString();
    onBlockTime(startISO, endISO);
  };

  return (
    <div className="overflow-auto">
      <div className={view === 'day' ? 'min-w-[300px]' : 'min-w-[600px]'}>
        {/* Header row */}
        <div className={cn('grid border-b border-gray-100', colTemplate)}>
          <div />
          {days.map(d => (
            <div key={d.toISOString()} className={cn('text-center py-2', isToday(d) && 'bg-blue-50/50 rounded-t')}>
              <div className="text-xs font-medium text-gray-500">{format(d, 'EEE')}</div>
              <div className={cn(
                'text-sm font-semibold',
                isToday(d) ? 'text-blue-600' : 'text-gray-900'
              )}>{format(d, 'd')}</div>
            </div>
          ))}
        </div>

        {/* Time rows */}
        {timeRows.map(row => (
          <div key={`${row.hour}:${row.minute}`} className={cn('grid', colTemplate)}>
            <div className="text-right pr-2 text-xs text-gray-400 leading-none pt-1 whitespace-nowrap">
              {row.label}
            </div>
            {days.map(d => {
              const dateKey = format(d, 'yyyy-MM-dd');
              const key = `${dateKey}:${String(row.hour).padStart(2, '0')}:${row.minute === 0 ? '00' : '30'}`;
              const busyCount = slotMap[key] ?? 0;
              const evInfo = eventSlotMap[key];
              const slotHeight = view === 'day' ? 'h-8' : 'h-5';

              if (evInfo) {
                const ev = evInfo.event;
                const minsUntil = minutesUntil(ev.start);
                const showJoinAlways = ev.meetLink && minsUntil <= 15 && minsUntil >= -60;
                const colors = MEETING_TYPE_COLORS[ev.meetingType ?? (ev.isProxi ? 'discovery' : 'personal')];
                const isPopoverOpen = popoverKey === key;

                return (
                  <div
                    key={key}
                    className={cn(
                      slotHeight, 'border-b border-r transition-colors overflow-visible relative group cursor-pointer',
                      colors.bg, colors.border,
                    )}
                    onClick={() => {
                      setPopoverEvent(isPopoverOpen ? null : ev);
                      setPopoverKey(isPopoverOpen ? null : key);
                    }}
                  >
                    {evInfo.isFirstSlot && (
                      <span className={cn('text-[9px] font-medium px-0.5 truncate block leading-5', colors.text)}>
                        {ev.summary}
                      </span>
                    )}

                    {/* Join button — always visible within 15 min, otherwise on hover */}
                    {ev.meetLink && evInfo.isFirstSlot && (
                      <a
                        href={ev.meetLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className={cn(
                          'absolute top-0 right-0 flex items-center gap-0.5 text-[9px] text-white bg-green-600 hover:bg-green-700 rounded-bl px-1 py-0.5 transition-all z-10',
                          showJoinAlways ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        )}
                      >
                        <Video className="h-2.5 w-2.5" />
                        Join
                      </a>
                    )}

                    {/* Popover */}
                    {isPopoverOpen && popoverEvent && (
                      <EventPopover
                        event={popoverEvent}
                        onClose={() => { setPopoverEvent(null); setPopoverKey(null); }}
                      />
                    )}
                  </div>
                );
              }

              // No event — use freebusy heatmap
              return (
                <div
                  key={key}
                  className={cn(
                    slotHeight, 'border-b border-r border-gray-50 transition-colors',
                    NON_PROXI_BUSY[Math.min(busyCount, connectedCount)] ?? 'bg-gray-500',
                    onBlockTime && 'cursor-pointer hover:ring-1 hover:ring-inset hover:ring-blue-300'
                  )}
                  title={busyCount === 0 ? 'All free — click to block' : `${busyCount} busy`}
                  onClick={() => busyCount === 0 && handleEmptySlotClick(dateKey, row.hour, row.minute)}
                />
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-4 pt-4 px-2 text-xs text-gray-500 flex-wrap">
          <span className="font-medium">Legend:</span>
          {Object.entries(MEETING_TYPE_COLORS).map(([type, colors]) => (
            <div key={type} className="flex items-center gap-1">
              <div className={cn('h-3 w-5 rounded-sm', colors.bg)} />
              <span>{colors.label}</span>
            </div>
          ))}
          {[
            { label: 'All free', cls: 'bg-emerald-50 border border-emerald-200' },
            { label: '1 busy', cls: 'bg-amber-100 border border-amber-200' },
            { label: '2 busy', cls: 'bg-orange-200 border border-orange-300' },
            { label: 'All busy', cls: 'bg-red-300 border border-red-400' },
          ].map(({ label, cls }) => (
            <div key={label} className="flex items-center gap-1">
              <div className={cn('h-3 w-5 rounded-sm', cls)} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
