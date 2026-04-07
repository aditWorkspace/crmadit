'use client';

import { useMemo } from 'react';
import { format, addDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isProxi: boolean;
}

interface AvailabilityGridProps {
  slots: Slot[];
  weekStart: Date;
  connectedCount: number;
  events?: CalendarEvent[];
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
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
}

function roundDownToSlot(iso: string): string {
  const d = new Date(iso);
  const m = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', minute: '2-digit' });
  const min = parseInt(m);
  const slotMin = min < 30 ? 0 : 30;
  // Return a date key + slot key for this rounded slot
  const h = getPTHour(iso);
  const dateKey = getDateKey(iso);
  return `${dateKey}:${String(h).padStart(2, '0')}:${slotMin === 0 ? '00' : '30'}`;
}

// How many 30-min steps does this event span?
function eventSlotCount(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.ceil(ms / (30 * 60 * 1000)));
}

interface EventSlotInfo {
  summary: string;
  isProxi: boolean;
  isFirstSlot: boolean;
  spanCount: number; // total slots the event spans (for height hint)
}

// Traffic-light palette: green = bookable, amber = 1 busy, orange = 2 busy, red = all busy
const NON_PROXI_BUSY: Record<number, string> = {
  0: 'bg-emerald-50 border-emerald-100',       // all free
  1: 'bg-amber-100 border-amber-200',           // 1 busy — still bookable
  2: 'bg-orange-200 border-orange-300',         // 2 busy — not bookable
  3: 'bg-red-300 border-red-400',               // all busy
};

export function AvailabilityGrid({ slots, weekStart, connectedCount, events = [] }: AvailabilityGridProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Build busy-count lookup: "YYYY-MM-DD:HH:mm" → busyCount
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

  // Build event slot lookup: slotKey → EventSlotInfo
  const eventSlotMap = useMemo(() => {
    const map: Record<string, EventSlotInfo> = {};

    for (const ev of events) {
      if (!ev.start || !ev.end) continue;
      const totalSpan = eventSlotCount(ev.start, ev.end);

      // Walk through slots this event covers
      const evStart = new Date(ev.start);
      const evEnd = new Date(ev.end);
      const cursor = new Date(evStart);
      // Round cursor down to nearest 30-min slot boundary (keep hour, snap minutes)
      const ptMin = getPTMinute(evStart.toISOString());
      cursor.setMinutes(ptMin, 0, 0);

      let slotIndex = 0;
      while (cursor < evEnd) {
        const h = getPTHour(cursor.toISOString());
        if (h >= START_HOUR && h < END_HOUR) {
          const key = roundDownToSlot(cursor.toISOString());
          if (!map[key]) {
            map[key] = {
              summary: ev.summary,
              isProxi: ev.isProxi,
              isFirstSlot: slotIndex === 0,
              spanCount: totalSpan,
            };
          }
        }
        cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
        slotIndex++;
      }

      // Ensure the first slot is marked — fallback if cursor logic missed it
      const firstKey = roundDownToSlot(evStart.toISOString());
      if (!map[firstKey]) {
        const h = getPTHour(evStart.toISOString());
        if (h >= START_HOUR && h < END_HOUR) {
          map[firstKey] = {
            summary: ev.summary,
            isProxi: ev.isProxi,
            isFirstSlot: true,
            spanCount: totalSpan,
          };
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

  return (
    <div className="overflow-auto">
      <div className="min-w-[600px]">
        {/* Header row */}
        <div className="grid grid-cols-[72px_repeat(7,1fr)] border-b border-gray-100">
          <div />
          {days.map(d => (
            <div key={d.toISOString()} className="text-center py-2">
              <div className="text-xs font-medium text-gray-500">{format(d, 'EEE')}</div>
              <div className="text-sm font-semibold text-gray-900">{format(d, 'd')}</div>
            </div>
          ))}
        </div>

        {/* Time rows */}
        {timeRows.map(row => (
          <div key={`${row.hour}:${row.minute}`} className="grid grid-cols-[72px_repeat(7,1fr)]">
            <div className="text-right pr-2 text-xs text-gray-400 leading-none pt-1 whitespace-nowrap">
              {row.label}
            </div>
            {days.map(d => {
              const dateKey = format(d, 'yyyy-MM-dd');
              const key = `${dateKey}:${String(row.hour).padStart(2, '0')}:${row.minute === 0 ? '00' : '30'}`;
              const busyCount = slotMap[key] ?? 0;
              const evInfo = eventSlotMap[key];

              if (evInfo?.isProxi) {
                // Proxi event: all founders in a meeting with a prospect → blue
                return (
                  <div
                    key={key}
                    className={cn(
                      'h-5 border-b border-r transition-colors overflow-hidden',
                      'bg-blue-500 border-blue-400',
                    )}
                    title={evInfo.summary}
                  >
                    {evInfo.isFirstSlot && (
                      <span className="text-[9px] text-white font-medium px-0.5 truncate block leading-5">
                        {evInfo.summary}
                      </span>
                    )}
                  </div>
                );
              }

              if (evInfo && !evInfo.isProxi) {
                // Personal/non-Proxi event → gray regardless of busy count
                return (
                  <div
                    key={key}
                    className="h-5 border-b border-r border-gray-100 bg-gray-200 transition-colors"
                    title={`Personal: ${evInfo.summary}`}
                  />
                );
              }

              // No event — use freebusy heatmap
              return (
                <div
                  key={key}
                  className={cn(
                    'h-5 border-b border-r border-gray-50 transition-colors',
                    NON_PROXI_BUSY[Math.min(busyCount, connectedCount)] ?? 'bg-gray-500'
                  )}
                  title={busyCount === 0 ? 'All free' : `${busyCount} busy`}
                />
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-4 pt-4 px-2 text-xs text-gray-500 flex-wrap">
          <span className="font-medium">Legend:</span>
          <div className="flex items-center gap-1">
            <div className="h-3 w-5 rounded-sm bg-blue-500" />
            <span>Proxi meeting</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="h-3 w-5 rounded-sm bg-gray-200 border border-gray-300" />
            <span>Personal busy</span>
          </div>
          {[
            { label: 'All free', cls: 'bg-emerald-50 border border-emerald-200' },
            { label: '1 busy — bookable', cls: 'bg-amber-100 border border-amber-200' },
            { label: '2 busy — blocked', cls: 'bg-orange-200 border border-orange-300' },
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
