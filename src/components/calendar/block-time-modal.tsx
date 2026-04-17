'use client';

import { useState } from 'react';
import { X, Loader2, Ban } from '@/lib/icons';
import { format, addDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface BlockTimeModalProps {
  onClose: () => void;
  onBlock: () => void;
  teamMemberId: string;
}

const TIME_OPTIONS: { label: string; value: string }[] = [];
for (let h = 7; h <= 20; h++) {
  for (const m of [0, 30]) {
    if (h === 20 && m === 30) continue;
    const hh = String(h).padStart(2, '0');
    const mm = m === 0 ? '00' : '30';
    const label = `${h > 12 ? h - 12 : h}:${mm} ${h >= 12 ? 'PM' : 'AM'}`;
    TIME_OPTIONS.push({ label, value: `${hh}:${mm}` });
  }
}

// Quick-pick presets for common blocking patterns
const QUICK_PRESETS = [
  { label: 'Morning (9a-12p)', start: '09:00', end: '12:00' },
  { label: 'Afternoon (12-5p)', start: '12:00', end: '17:00' },
  { label: 'All day', allDay: true },
] as const;

export function BlockTimeModal({ onClose, onBlock, teamMemberId }: BlockTimeModalProps) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [date, setDate] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate next 14 days for quick date pills
  const quickDates = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(new Date(), i);
    const day = d.getDay();
    // Skip weekends
    if (day === 0 || day === 6) return null;
    return d;
  }).filter(Boolean) as Date[];

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        summary: summary.trim() || 'Blocked',
        allDay,
      };
      if (allDay) {
        body.date = date;
      } else {
        // Build ISO datetime strings from date + time
        body.start = `${date}T${startTime}:00`;
        body.end = `${date}T${endTime}:00`;
      }

      const res = await fetch('/api/calendar/block-time', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': teamMemberId,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to block time');
      }

      onBlock();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const endTimeValid = allDay || endTime > startTime;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-gray-400" />
            <h2 className="text-base font-semibold text-gray-900">Block time</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Quick date pills */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Date</label>
            <div className="flex flex-wrap gap-1.5">
              {quickDates.slice(0, 8).map(d => {
                const key = format(d, 'yyyy-MM-dd');
                const isSelected = key === date;
                const isToday = key === today;
                return (
                  <button
                    key={key}
                    onClick={() => setDate(key)}
                    className={cn(
                      'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      isSelected
                        ? 'bg-gray-900 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    )}
                  >
                    {isToday ? 'Today' : format(d, 'EEE M/d')}
                  </button>
                );
              })}
            </div>
            {/* Fallback date input for dates beyond the pills */}
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              min={today}
              className="mt-2 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-gray-400"
            />
          </div>

          {/* Quick presets */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Quick block</label>
            <div className="flex gap-2">
              {QUICK_PRESETS.map(preset => {
                const isActive = 'allDay' in preset
                  ? allDay
                  : !allDay && startTime === preset.start && endTime === preset.end;
                return (
                  <button
                    key={preset.label}
                    onClick={() => {
                      if ('allDay' in preset) {
                        setAllDay(true);
                      } else {
                        setAllDay(false);
                        setStartTime(preset.start);
                        setEndTime(preset.end);
                      }
                    }}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
                      isActive
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100'
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom time range (shown when not all-day) */}
          {!allDay && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
                <select
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-gray-400"
                >
                  {TIME_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
                <select
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-gray-400"
                >
                  {TIME_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Optional label */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Label <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={summary}
              onChange={e => setSummary(e.target.value)}
              placeholder="e.g. Focus time, Out of office"
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:border-gray-400"
            />
          </div>

          {/* Validation / error */}
          {!endTimeValid && (
            <p className="text-xs text-red-500">End time must be after start time</p>
          )}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !endTimeValid}
            className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Block {allDay ? format(new Date(date + 'T12:00:00'), 'MMM d') : 'time'}
          </button>
        </div>
      </div>
    </div>
  );
}
