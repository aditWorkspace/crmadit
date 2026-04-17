'use client';

import { useState, useEffect, useCallback } from 'react';
import { startOfWeek, addWeeks, addDays, endOfDay, subDays } from 'date-fns';
import { format } from 'date-fns';
import { useSession } from '@/hooks/use-session';
import { AvailabilityGrid, CalendarEvent } from '@/components/calendar/availability-grid';
import { UpcomingCalls } from '@/components/calendar/upcoming-calls';
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, ExternalLink, CalendarDays, Calendar as CalendarIcon, Ban } from 'lucide-react';
import { BlockTimeModal } from '@/components/calendar/block-time-modal';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

type ViewMode = 'week' | 'day';

export default function CalendarPage() {
  const { user } = useSession();
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 })
  );
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showBlockModal, setShowBlockModal] = useState(false);

  const fetchAvailability = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const start = viewMode === 'day' ? selectedDay : weekStart;
    const end = viewMode === 'day' ? endOfDay(selectedDay) : endOfDay(addDays(weekStart, 6));
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
  }, [user, weekStart, selectedDay, viewMode]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  const navigate = (dir: -1 | 1) => {
    if (viewMode === 'week') {
      setWeekStart(w => addWeeks(w, dir));
    } else {
      setSelectedDay(d => dir === 1 ? addDays(d, 1) : subDays(d, 1));
    }
  };

  const handleBlockTime = async (start: string, end: string) => {
    if (!user) return;
    const summary = 'Blocked';
    try {
      const res = await fetch('/api/calendar/block-time', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': user.team_member_id,
        },
        body: JSON.stringify({ start, end, summary }),
      });
      if (!res.ok) throw new Error('Failed to block time');
      toast.success('Time blocked');
      fetchAvailability();
    } catch {
      toast.error('Failed to block time');
    }
  };

  const dateLabel = viewMode === 'week'
    ? `${format(weekStart, 'MMM d')} – ${format(addDays(weekStart, 6), 'MMM d, yyyy')}`
    : format(selectedDay, 'EEEE, MMMM d, yyyy');

  return (
    <div className="flex flex-col h-full p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Shared availability across all connected founders
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('week')}
              className={cn(
                'flex items-center gap-1 text-xs px-2.5 py-1.5 transition-colors',
                viewMode === 'week' ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Week
            </button>
            <button
              onClick={() => { setViewMode('day'); setSelectedDay(new Date()); }}
              className={cn(
                'flex items-center gap-1 text-xs px-2.5 py-1.5 transition-colors',
                viewMode === 'day' ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              <CalendarIcon className="h-3.5 w-3.5" />
              Day
            </button>
          </div>
          <button
            onClick={() => setShowBlockModal(true)}
            className="flex items-center gap-1.5 text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 transition-colors"
          >
            <Ban className="h-3.5 w-3.5" />
            Block time
          </button>
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

      {/* Upcoming calls banner */}
      <UpcomingCalls events={events} />

      {/* Navigation */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate(-1)} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-gray-700 min-w-[200px] text-center">
          {dateLabel}
        </span>
        <button onClick={() => navigate(1)} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronRight className="h-5 w-5" />
        </button>
        <button
          onClick={() => {
            if (viewMode === 'week') setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }));
            else setSelectedDay(new Date());
          }}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium ml-1"
        >
          Today
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4">
        {loading && slots.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
          </div>
        ) : (
          <AvailabilityGrid
            slots={slots}
            weekStart={weekStart}
            connectedCount={connectedCount}
            events={events}
            view={viewMode}
            selectedDay={selectedDay}
            onBlockTime={handleBlockTime}
          />
        )}
      </div>

      {showBlockModal && user && (
        <BlockTimeModal
          teamMemberId={user.team_member_id}
          onClose={() => setShowBlockModal(false)}
          onBlock={() => {
            toast.success('Time blocked');
            fetchAvailability();
          }}
        />
      )}
    </div>
  );
}
