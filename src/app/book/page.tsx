'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  startOfMonth, endOfMonth, addMonths, subMonths,
  startOfWeek, addDays, isSameMonth, isToday, isBefore, startOfDay,
  format, isSameDay, parseISO
} from 'date-fns';
import { ChevronLeft, ChevronRight, Video, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TimeSlotList } from '@/components/calendar/time-slot-list';
import { BookingForm } from '@/components/calendar/booking-form';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

type Step = 'calendar' | 'slots' | 'form';

const DURATION_OPTIONS: { value: 10 | 20 | 30; label: string }[] = [
  { value: 10, label: '10m' },
  { value: 20, label: '20m' },
  { value: 30, label: '30m' },
];

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
  return parseInt(
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      minute: '2-digit',
    })
  );
}

/** Earliest slot: 9:30 AM PT. Last slot that can start: 4:30 PM PT (ends at 5:00 PM). */
function isBookableHour(iso: string): boolean {
  const h = getPTHour(iso);
  const m = getPTMinute(iso);
  const afterEarliest = h > 9 || (h === 9 && m >= 30);
  const beforeLatest = h < 17 || (h === 17 && m === 0);
  return afterEarliest && beforeLatest;
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function todayPT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export default function BookPage() {
  const router = useRouter();
  const [month, setMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [duration, setDuration] = useState<10 | 20 | 30>(20);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [step, setStep] = useState<Step>('calendar');
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotCache] = useState(() => new Map<string, Slot[]>());
  // Detect browser timezone on mount; default to PT while hydrating
  const [userTz, setUserTz] = useState('America/Los_Angeles');
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setUserTz(tz);
  }, []);

  const fetchSlots = useCallback(async () => {
    const monthKey = format(month, 'yyyy-MM');
    const cached = slotCache.get(monthKey);
    if (cached) {
      setSlots(cached);
      return;
    }
    setLoadingSlots(true);
    try {
      const start = startOfMonth(month);
      const end = endOfMonth(addMonths(month, 1));
      const res = await fetch(
        `/api/calendar/availability?start=${start.toISOString()}&end=${end.toISOString()}&bookingOnly=true`
      );
      const data = await res.json();
      const newSlots = data.slots ?? [];
      setSlots(newSlots);
      slotCache.set(monthKey, newSlots);
      if (data.failedCount > 0) {
        console.warn(`[booking] ${data.failedCount}/${data.connectedCount} calendar fetches failed — those members treated as busy`);
      }
    } catch {
      // keep stale
    } finally {
      setLoadingSlots(false);
    }
  }, [month, slotCache]);

  useEffect(() => { fetchSlots(); }, [fetchSlots]);

  const daysWithSlots = useMemo(() => {
    // With bookingOnly=true, the API already filters to weekday business
    // hours with busyCount ≤ 1 and excludes past dates. Just collect dates.
    const days = new Set<string>();
    for (const s of slots) {
      const date = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      days.add(date);
    }
    return days;
  }, [slots]);

  const slotsForDay = useMemo(() => {
    if (!selectedDate) return [];
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    return slots.filter(s => {
      const slotDateKey = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      return slotDateKey === dateKey;
    });
  }, [slots, selectedDate]);

  const calendarDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) days.push(addDays(start, i));
    return days;
  }, [month]);

  const handleDateSelect = (d: Date) => {
    const key = format(d, 'yyyy-MM-dd');
    if (!daysWithSlots.has(key)) return;
    setSelectedDate(d);
    setSelectedSlot(null);
    setStep('slots');
  };

  const handleSlotSelect = (start: string) => {
    setSelectedSlot(start);
    setStep('form');
  };

  const handleBook = async (data: { name: string; email: string; note: string }) => {
    if (!selectedSlot) return;
    const res = await fetch('/api/calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        startTime: selectedSlot,
        durationMinutes: duration,
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Booking failed');

    const params = new URLSearchParams({
      meetLink: result.meetLink ?? '',
      startTime: result.startTime,
      endTime: result.endTime,
      name: data.name,
      durationMinutes: String(duration),
    });
    router.push(`/book/confirmation?${params.toString()}`);
  };

  return (
    <div className="min-h-screen bg-[#111] flex items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-[900px] bg-[#1c1c1c] border border-gray-800 rounded-2xl overflow-hidden flex flex-col md:flex-row">

        {/* Left panel — team info */}
        <div className="p-6 md:p-8 md:w-[260px] md:border-r border-gray-800 flex-shrink-0">
          <div className="h-10 w-10 rounded-full bg-gray-700 flex items-center justify-center text-white font-semibold text-sm mb-4">
            P
          </div>
          <p className="text-gray-400 text-xs font-medium mb-1">Adit, Srijay & Asim</p>
          <h1 className="text-xl font-bold text-white mb-2">Quick chat</h1>
          <p className="text-gray-400 text-sm mb-6">We're curious about how you think about prioritization and workflows. Would love to learn from you.</p>

          <div className="flex items-center gap-1.5 mb-5">
            <span className="text-gray-500 text-xs mr-1">⏱</span>
            {DURATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDuration(opt.value)}
                className={cn(
                  'px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  duration === opt.value
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-gray-500 text-xs mb-2">
            <Video className="h-3.5 w-3.5" />
            Google Meet
          </div>
          <div className="flex items-center gap-2 text-gray-500 text-xs">
            <Globe className="h-3.5 w-3.5" />
            {userTz}
          </div>
        </div>

        {/* Center — month calendar */}
        <div className="p-6 md:p-8 flex-1 md:border-r border-gray-800">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-white font-semibold">
              {format(month, 'MMMM')}{' '}
              <span className="text-gray-500 font-normal">{format(month, 'yyyy')}</span>
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMonth(m => subMonths(m, 1))}
                disabled={isBefore(startOfDay(subMonths(month, 1)), startOfDay(new Date()))}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-default"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setMonth(m => addMonths(m, 1))}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 mb-2">
            {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(d => (
              <div key={d} className="text-center text-xs font-medium text-gray-500 py-1">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((d, i) => {
              const key = format(d, 'yyyy-MM-dd');
              const inMonth = isSameMonth(d, month);
              const available = !loadingSlots && daysWithSlots.has(key);
              const selected = selectedDate ? isSameDay(d, selectedDate) : false;
              const today = isToday(d);
              const isPotentiallyAvailable = loadingSlots && inMonth && isWeekday(d) && !isBefore(d, startOfDay(new Date()));

              return (
                <button
                  key={i}
                  onClick={() => handleDateSelect(d)}
                  disabled={!available || !inMonth}
                  className={cn(
                    'aspect-square flex items-center justify-center rounded-lg text-sm transition-colors relative',
                    !inMonth && 'opacity-0 pointer-events-none',
                    isPotentiallyAvailable && 'bg-gray-800/50 text-gray-400 animate-pulse',
                    inMonth && !available && !isPotentiallyAvailable && 'text-gray-600 cursor-default',
                    inMonth && available && !selected && 'bg-gray-800 text-white hover:bg-gray-700 cursor-pointer',
                    selected && 'bg-white text-gray-900 font-semibold',
                    today && !selected && 'ring-1 ring-gray-500'
                  )}
                >
                  {format(d, 'd')}
                  {today && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-0.5 rounded-full bg-current" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right panel — slots or form */}
        {(step === 'slots' || step === 'form') && selectedDate && (
          <div className="p-6 md:p-8 md:w-[260px] flex-shrink-0">
            <h3 className="text-white font-semibold mb-1">
              {format(selectedDate, 'EEE')} <span className="font-bold">{format(selectedDate, 'd')}</span>
            </h3>
            <div className="flex items-center gap-2 mb-5">
              <button onClick={() => setStep('calendar')} className="text-xs text-gray-400 hover:text-gray-200">← Back</button>
            </div>

            {step === 'slots' && (
              <TimeSlotList
                slots={slotsForDay}
                selectedSlot={selectedSlot}
                durationMinutes={duration}
                timezone={userTz}
                onSelect={handleSlotSelect}
              />
            )}

            {step === 'form' && selectedSlot && (
              <BookingForm
                startTime={selectedSlot}
                durationMinutes={duration}
                timezone={userTz}
                onBack={() => setStep('slots')}
                onConfirm={handleBook}
              />
            )}
          </div>
        )}
      </div>

      <div className="fixed bottom-4 left-0 right-0 text-center text-xs text-gray-600">
        Berkeley founders · Scheduling
      </div>
    </div>
  );
}
