'use client';

import { useState, useEffect, useCallback } from 'react';
import { startOfWeek, addWeeks, addDays, endOfDay } from 'date-fns';
import { format } from 'date-fns';
import { useSession } from '@/hooks/use-session';
import { AvailabilityGrid } from '@/components/calendar/availability-grid';
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, ExternalLink } from 'lucide-react';

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

export default function CalendarPage() {
  const { user } = useSession();
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 }) // Monday
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchAvailability = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const start = weekStart;
    const end = endOfDay(addDays(weekStart, 6));
    try {
      const res = await fetch(
        `/api/calendar/availability?start=${start.toISOString()}&end=${end.toISOString()}`,
        { headers: { 'x-team-member-id': user.team_member_id } }
      );
      const data = await res.json();
      setSlots(data.slots ?? []);
      setEvents(data.events ?? []);
      setConnectedCount(data.connectedCount ?? 3);
    } catch {
      // keep stale data
    } finally {
      setLoading(false);
    }
  }, [user, weekStart]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  const prevWeek = () => setWeekStart(w => addWeeks(w, -1));
  const nextWeek = () => setWeekStart(w => addWeeks(w, 1));

  return (
    <div className="flex flex-col h-full p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Shared availability across all connected founders
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/book"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Public booking page
          </a>
          <button
            onClick={fetchAvailability}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors p-1"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={prevWeek} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-gray-700 min-w-[160px] text-center">
          {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}
        </span>
        <button onClick={nextWeek} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4">
        {loading && slots.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
          </div>
        ) : (
          <AvailabilityGrid slots={slots} weekStart={weekStart} connectedCount={connectedCount} events={events} />
        )}
      </div>
    </div>
  );
}
