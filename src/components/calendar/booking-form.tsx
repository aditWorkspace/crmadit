'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, ArrowLeft, X, Calendar, Clock, Video, Plus, Users } from '@/lib/icons';
import { cn } from '@/lib/utils';

interface BookingFormProps {
  startTime: string;
  durationMinutes: 15 | 30;
  timezone: string;
  onBack: () => void;
  onConfirm: (data: { name: string; email: string; note: string; guestEmails: string[] }) => Promise<void>;
  defaultName?: string;
  defaultEmail?: string;
  isReschedule?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseGuestEmails(raw: string, bookerEmail: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>([bookerEmail.trim().toLowerCase()]);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of raw.split(/[,\n]/)) {
    const e = piece.trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL_RE.test(e) ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

function formatDateLine(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatTimeLine(iso: string, tz: string): string {
  const date = new Date(iso);
  const timePart = date.toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tzAbbr =
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .find(p => p.type === 'timeZoneName')?.value ?? '';
  return `${timePart} · ${tzAbbr}`;
}

export function BookingForm({
  startTime,
  durationMinutes,
  timezone,
  onBack,
  onConfirm,
  defaultName,
  defaultEmail,
  isReschedule,
}: BookingFormProps) {
  const [name, setName] = useState(defaultName ?? '');
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [note, setNote] = useState('');
  const [showGuests, setShowGuests] = useState(false);
  const [guestsRaw, setGuestsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const guestsInputRef = useRef<HTMLInputElement>(null);

  const guestPreview = useMemo(
    () => parseGuestEmails(guestsRaw, email),
    [guestsRaw, email]
  );

  // Lock body scroll + focus first field + Esc to close
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => nameInputRef.current?.focus(), 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [onBack, submitting]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    if (guestPreview.invalid.length > 0) {
      setError(`Invalid guest email${guestPreview.invalid.length > 1 ? 's' : ''}: ${guestPreview.invalid.join(', ')}`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        name: name.trim(),
        email: email.trim(),
        note: note.trim(),
        guestEmails: guestPreview.valid,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  };

  const inputBase =
    'w-full rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-gray-500 ' +
    'bg-white/[0.04] border border-white/10 ' +
    'hover:border-white/20 ' +
    'focus:outline-none focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/20 ' +
    'transition-colors';

  return (
    <div
      className="booking-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={() => !submitting && onBack()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="booking-modal-title"
    >
      <div
        className="booking-modal-card relative w-full max-w-[440px] bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          type="button"
          onClick={() => !submitting && onBack()}
          disabled={submitting}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 pt-6 pb-5">
          <h2 id="booking-modal-title" className="text-lg font-semibold text-white">
            {isReschedule ? 'Confirm your new time' : "You're almost there"}
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Fill in your details to {isReschedule ? 'reschedule' : 'confirm'} the call.
          </p>
        </div>

        {/* Selected time summary */}
        <div className="mx-6 mb-5 p-3.5 rounded-lg bg-white/[0.03] border border-white/10">
          <div className="flex items-center gap-2 text-sm text-white font-medium">
            <Calendar className="h-3.5 w-3.5 text-gray-400" />
            {formatDateLine(startTime, timezone)}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400 mt-1.5">
            <Clock className="h-3 w-3" />
            {formatTimeLine(startTime, timezone)} · {durationMinutes} min
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
            <Video className="h-3 w-3" />
            Google Meet
          </div>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">
              Your name <span className="text-red-400">*</span>
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Jane Smith"
              required
              aria-required="true"
              className={inputBase}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">
              Email address <span className="text-red-400">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="jane@company.com"
              required
              aria-required="true"
              className={inputBase}
            />
            {!showGuests ? (
              <button
                type="button"
                onClick={() => {
                  setShowGuests(true);
                  setTimeout(() => guestsInputRef.current?.focus(), 40);
                }}
                className="mt-2 inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
              >
                <Plus className="h-3 w-3" />
                Add guests
              </button>
            ) : (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-gray-300">
                    <Users className="h-3 w-3 text-gray-400" />
                    Guests
                  </label>
                  <button
                    type="button"
                    onClick={() => { setShowGuests(false); setGuestsRaw(''); }}
                    className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
                <input
                  ref={guestsInputRef}
                  type="text"
                  value={guestsRaw}
                  onChange={e => setGuestsRaw(e.target.value)}
                  placeholder="alex@co.com, sam@co.com"
                  className={inputBase}
                />
                {(guestPreview.valid.length > 0 || guestPreview.invalid.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {guestPreview.valid.map(g => (
                      <span
                        key={g}
                        className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] border border-white/10 px-2 py-0.5 text-[11px] text-gray-200"
                      >
                        {g}
                      </span>
                    ))}
                    {guestPreview.invalid.map(g => (
                      <span
                        key={g}
                        className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300"
                        title="Invalid email"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-gray-500 mt-1.5">
                  Separate multiple emails with commas. Each will receive the calendar invite.
                </p>
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">
              Additional notes
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Anything you'd like us to know beforehand?"
              rows={3}
              className={cn(inputBase, 'resize-none min-h-[84px]')}
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 border-l-2 border-red-500/60 pl-3 py-1">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onBack}
              disabled={submitting}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !email.trim()}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold',
                'bg-white text-gray-900 hover:bg-gray-100 active:scale-[0.99]',
                'transition-all duration-150 ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:active:scale-100'
              )}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {isReschedule ? 'Confirm new time' : 'Confirm booking'}
            </button>
          </div>

          <p className="text-[11px] text-gray-500 text-center pt-1">
            Press <span className="font-mono text-gray-400">Esc</span> to close
          </p>
        </form>
      </div>
    </div>
  );
}
