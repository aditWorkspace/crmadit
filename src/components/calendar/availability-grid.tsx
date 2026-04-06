'use client';

import { useMemo } from 'react';
import { format, addDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface AvailabilityGridProps {
  slots: Slot[];
  weekStart: Date;
  connectedCount: number;
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

const BUSY_COLORS: Record<number, string> = {
  0: 'bg-white hover:bg-blue-50 cursor-pointer',
  1: 'bg-gray-100',
  2: 'bg-gray-400',
  3: 'bg-gray-800',
};

export function AvailabilityGrid({ slots, weekStart, connectedCount }: AvailabilityGridProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Build lookup: "YYYY-MM-DD:HH:mm" → busyCount
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
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-100">
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
          <div key={`${row.hour}:${row.minute}`} className="grid grid-cols-[60px_repeat(7,1fr)]">
            <div className="text-right pr-2 text-xs text-gray-400 leading-none pt-1">
              {row.label}
            </div>
            {days.map(d => {
              const dateKey = format(d, 'yyyy-MM-dd');
              const key = `${dateKey}:${String(row.hour).padStart(2, '0')}:${row.minute === 0 ? '00' : '30'}`;
              const busyCount = slotMap[key] ?? 0;
              return (
                <div
                  key={key}
                  className={cn(
                    'h-5 border-b border-r border-gray-50 transition-colors',
                    BUSY_COLORS[Math.min(busyCount, connectedCount)] ?? 'bg-gray-800'
                  )}
                  title={busyCount === 0 ? 'All free' : `${busyCount} busy`}
                />
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-4 pt-4 px-2 text-xs text-gray-500">
          <span className="font-medium">Busy founders:</span>
          {[
            { count: 0, label: 'None', cls: 'bg-white border border-gray-200' },
            { count: 1, label: '1', cls: 'bg-gray-100' },
            { count: 2, label: '2', cls: 'bg-gray-400' },
            { count: 3, label: '3', cls: 'bg-gray-800' },
          ].map(({ count, label, cls }) => (
            <div key={count} className="flex items-center gap-1">
              <div className={cn('h-3 w-5 rounded-sm', cls)} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
