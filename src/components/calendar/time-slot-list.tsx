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
  durationMinutes: 15 | 30;
  timezone: string; // IANA timezone string from visitor's browser
  loading?: boolean;
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

function SlotSkeleton() {
  return (
    <div className="space-y-2 overflow-hidden max-h-[480px] pr-1" aria-busy="true" aria-live="polite">
      <div className="h-3 w-32 rounded bg-gray-800 mb-3 relative overflow-hidden">
        <span className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="relative overflow-hidden h-11 rounded-lg border border-gray-800 bg-gray-900/40"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <span
            className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent"
            style={{ animationDelay: `${i * 80}ms` }}
          />
          <div className="flex items-center gap-2.5 h-full px-4">
            <span className="h-2 w-2 rounded-full bg-gray-700" />
            <span className="h-3 w-20 rounded bg-gray-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TimeSlotList({ slots, selectedSlot, durationMinutes: _dur, timezone, loading, onSelect }: TimeSlotListProps) {
  const bookableSlots = slots.filter(s => s.busyCount <= 1);
  const tzAbbr = getTzAbbr(timezone);

  if (loading && bookableSlots.length === 0) {
    return <SlotSkeleton />;
  }

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
              'group cursor-pointer w-full flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm font-medium',
              'transition-all duration-150 ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
              selected
                ? 'border-white bg-white text-gray-900 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]'
                : 'border-gray-700 text-gray-200 hover:border-gray-400 hover:bg-gray-800/60 hover:text-white active:scale-[0.99]'
            )}
          >
            <span
              className={cn(
                'h-2 w-2 rounded-full flex-shrink-0 transition-colors',
                selected ? 'bg-green-500' : 'bg-green-400/80 group-hover:bg-green-400'
              )}
            />
            {formatInTz(slot.start, timezone)} {tzAbbr}
          </button>
        );
      })}
    </div>
  );
}
