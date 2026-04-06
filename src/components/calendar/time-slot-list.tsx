'use client';

import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface TimeSlotListProps {
  slots: Slot[];           // already filtered to selected date + business hours
  selectedSlot: string | null;
  durationMinutes: 15 | 30;
  onSelect: (start: string) => void;
}

function formatPT(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function TimeSlotList({ slots, selectedSlot, durationMinutes: _durationMinutes, onSelect }: TimeSlotListProps) {
  const bookableSlots = slots.filter(s => s.busyCount <= 1); // ≥2 of 3 are free

  if (bookableSlots.length === 0) {
    return (
      <p className="text-sm text-gray-500 px-2 py-4">No available times on this day.</p>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto max-h-[480px] pr-1">
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
            {formatPT(slot.start)}
          </button>
        );
      })}
    </div>
  );
}
