'use client';

import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface TimeSlotListProps {
  slots: Slot[];
  selectedSlot: string | null;
  durationMinutes: 10 | 20 | 30;
  timezone: string; // IANA timezone string from visitor's browser
  onSelect: (start: string) => void;
}

function formatInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getTzAbbr(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(new Date());
  return parts.find(p => p.type === 'timeZoneName')?.value ?? tz;
}

export function TimeSlotList({ slots, selectedSlot, durationMinutes: _dur, timezone, onSelect }: TimeSlotListProps) {
  const bookableSlots = slots.filter(s => s.busyCount <= 1);
  const tzAbbr = getTzAbbr(timezone);

  if (bookableSlots.length === 0) {
    return (
      <p className="text-sm text-gray-500 px-2 py-4">No available times on this day.</p>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto max-h-[480px] pr-1">
      <p className="text-[11px] text-gray-500 px-1 mb-3">
        Times shown in <span className="text-gray-300 font-medium">{tzAbbr}</span>
        {timezone !== 'America/Los_Angeles' && (
          <span className="text-gray-600"> · booking enforced in PT</span>
        )}
      </p>
      {bookableSlots.map(slot => {
        const selected = selectedSlot === slot.start;
        return (
          <button
            key={slot.start}
            onClick={() => onSelect(slot.start)}
            className={cn(
              'w-full flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm font-medium transition-colors',
              selected
                ? 'border-white bg-white text-gray-900'
                : 'border-gray-700 text-gray-200 hover:border-gray-400 hover:text-white'
            )}
          >
            <span className={cn('h-2 w-2 rounded-full flex-shrink-0', selected ? 'bg-green-500' : 'bg-green-400')} />
            {formatInTz(slot.start, timezone)} {tzAbbr}
          </button>
        );
      })}
    </div>
  );
}
