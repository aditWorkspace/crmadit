'use client';

import { useState } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';

interface BookingFormProps {
  startTime: string;
  durationMinutes: 20 | 30;
  timezone: string;
  onBack: () => void;
  onConfirm: (data: { name: string; email: string; note: string }) => Promise<void>;
}

function formatInTz(iso: string, tz: string): string {
  const date = new Date(iso);
  const datePart = date.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const timePart = date.toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tzAbbr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '';

  return `${datePart} · ${timePart} ${tzAbbr}`;
}

export function BookingForm({ startTime, durationMinutes, timezone, onBack, onConfirm }: BookingFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({ name: name.trim(), email: email.trim(), note: note.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300">
        <div className="font-medium text-white">
          {formatInTz(startTime, timezone)}
        </div>
        <div className="text-gray-400 mt-0.5">{durationMinutes} min · Google Meet</div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Your name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Jane Smith"
            required
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Email address *</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="jane@company.com"
            required
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Additional notes</label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Anything you'd like us to know beforehand?"
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors resize-none"
          />
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !email.trim()}
            className="flex-1 flex items-center justify-center gap-2 bg-white text-gray-900 rounded-lg py-2.5 text-sm font-semibold hover:bg-gray-100 disabled:opacity-40 transition-colors"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm booking
          </button>
        </div>
      </form>
    </div>
  );
}
