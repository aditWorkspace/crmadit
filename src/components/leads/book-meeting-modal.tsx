'use client';

import { useState } from 'react';
import { X, CalendarPlus, ExternalLink, Video, Loader2 } from '@/lib/icons';
import { toast } from 'sonner';

interface BookMeetingModalProps {
  leadId: string;
  leadName: string;
  companyName: string;
  teamMemberId: string;
  onClose: () => void;
  onBooked: (startTime: string, meetLink: string | null) => void;
}

const DURATION_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '45 min', value: 45 },
  { label: '1 hour', value: 60 },
];

function defaultDateTimeLocal(): string {
  // Default to tomorrow at 10am PT
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  // datetime-local wants YYYY-MM-DDTHH:MM
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BookMeetingModal({
  leadId,
  leadName,
  companyName,
  teamMemberId,
  onClose,
  onBooked,
}: BookMeetingModalProps) {
  const [dateTime, setDateTime] = useState(defaultDateTimeLocal());
  const [duration, setDuration] = useState(30);
  const [booking, setBooking] = useState(false);
  const [result, setResult] = useState<{ eventLink: string; meetLink: string | null } | null>(null);

  const handleBook = async () => {
    if (!dateTime) return;
    setBooking(true);
    try {
      // Convert the local datetime string to ISO — treat as PT
      const localDate = new Date(dateTime);
      const res = await fetch(`/api/leads/${leadId}/book-meeting`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': teamMemberId,
        },
        body: JSON.stringify({
          start_time: localDate.toISOString(),
          duration_minutes: duration,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to book meeting');
        return;
      }

      setResult({ eventLink: data.event.eventLink, meetLink: data.event.meetLink });
      onBooked(data.event.startTime, data.event.meetLink);
      toast.success('Meeting booked — invites sent to all attendees');
    } catch {
      toast.error('Failed to book meeting');
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-gray-600" />
            <h3 className="text-sm font-semibold text-gray-800">Book a Meeting</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Who */}
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">With</p>
            <p className="text-sm font-medium text-gray-900">{leadName} · {companyName}</p>
            <p className="text-xs text-gray-400 mt-0.5">All connected founders will be added as attendees</p>
          </div>

          {/* Date + time */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1">Date & Time</label>
            <input
              type="datetime-local"
              value={dateTime}
              onChange={e => setDateTime(e.target.value)}
              className="w-full text-sm rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Duration */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1.5">Duration</label>
            <div className="flex gap-2">
              {DURATION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setDuration(opt.value)}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    duration === opt.value
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Success state */}
          {result && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-3 space-y-2">
              <p className="text-xs font-medium text-green-800">Meeting booked! Invites sent.</p>
              <div className="flex flex-col gap-1.5">
                <a
                  href={result.eventLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  View in Google Calendar
                </a>
                {result.meetLink && (
                  <a
                    href={result.meetLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-green-700 hover:underline"
                  >
                    <Video className="h-3 w-3" />
                    Join Google Meet
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={handleBook}
              disabled={booking || !dateTime}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40 transition-colors"
            >
              {booking ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Booking...
                </>
              ) : (
                <>
                  <CalendarPlus className="h-3.5 w-3.5" />
                  Book & Send Invites
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
