'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { toast } from 'sonner';
import {
  addDays,
  nextMonday,
  setHours,
  setMinutes,
  setSeconds,
  setMilliseconds,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { Clock, Calendar, X } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';

const TZ = 'America/Los_Angeles';

type Preset = {
  id: string;
  label: string;
  sub: string;
  compute: () => Date | null;
};

/**
 * Build the PT "today at 18:00" instant as a UTC Date. If that moment has
 * already passed in PT wall-clock time, return null (so the chip can be hidden).
 */
function tonightSixPT(): Date | null {
  // Current PT wall time
  const nowPt = toZonedTime(new Date(), TZ);
  // PT wall time at 18:00 today
  let target = setMilliseconds(setSeconds(setMinutes(setHours(nowPt, 18), 0), 0), 0);
  if (target.getTime() <= nowPt.getTime()) {
    return null;
  }
  // Reinterpret that wall-clock time as a PT instant -> UTC Date
  return fromZonedTime(target, TZ);
}

function tomorrowNinePT(): Date {
  const nowPt = toZonedTime(new Date(), TZ);
  const next = addDays(nowPt, 1);
  const target = setMilliseconds(setSeconds(setMinutes(setHours(next, 9), 0), 0), 0);
  return fromZonedTime(target, TZ);
}

function nextMondayNinePT(): Date {
  const nowPt = toZonedTime(new Date(), TZ);
  const mon = nextMonday(nowPt);
  const target = setMilliseconds(setSeconds(setMinutes(setHours(mon, 9), 0), 0), 0);
  return fromZonedTime(target, TZ);
}

function threeHoursFromNow(): Date {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

function formatPreview(d: Date): string {
  return formatInTimeZone(d, TZ, 'EEE MMM d, h:mm a') + ' PT';
}

export function SnoozePopover() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  // Listen for snooze requests anywhere in the app.
  useEffect(() => {
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<{ threadId: string }>;
      const id = e.detail?.threadId;
      if (!id) return;
      const el = document.querySelector<HTMLElement>(
        `[data-action="snooze-trigger"][data-thread-id="${CSS.escape(id)}"]`
      );
      lastTriggerRef.current = el ?? null;
      setAnchor(el ?? null);
      setThreadId(id);
      setCustomValue('');
      setOpen(true);
    };
    window.addEventListener('inbox:open-snooze', handler as EventListener);
    return () =>
      window.removeEventListener('inbox:open-snooze', handler as EventListener);
  }, []);

  const presets = useMemo<Preset[]>(
    () => [
      {
        id: '3h',
        label: '3 hours',
        sub: 'Later today',
        compute: threeHoursFromNow,
      },
      {
        id: 'tonight',
        label: 'Tonight 6pm PT',
        sub: 'This evening',
        compute: tonightSixPT,
      },
      {
        id: 'tomorrow',
        label: 'Tomorrow 9am PT',
        sub: 'Start of day',
        compute: tomorrowNinePT,
      },
      {
        id: 'monday',
        label: 'Next Monday 9am PT',
        sub: 'Start of the week',
        compute: nextMondayNinePT,
      },
    ],
    []
  );

  const sendSnooze = useCallback(
    async (until: Date) => {
      if (!user || !threadId) return;
      if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
        toast.error('Pick a time in the future');
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch(
          `/api/inbox/threads/${encodeURIComponent(threadId)}/snooze`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-team-member-id': user.team_member_id,
            },
            body: JSON.stringify({ snoozed_until: until.toISOString() }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(data?.error || 'Failed to snooze');
          return;
        }
        toast.success(`Snoozed until ${formatPreview(until)}`);
        window.dispatchEvent(
          new CustomEvent('inbox:snoozed', {
            detail: { threadId, snoozed_until: until.toISOString() },
          })
        );
        setOpen(false);
      } catch {
        toast.error('Failed to snooze');
      } finally {
        setSubmitting(false);
      }
    },
    [user, threadId]
  );

  const sendUnsnooze = useCallback(async () => {
    if (!user || !threadId) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/inbox/threads/${encodeURIComponent(threadId)}/snooze`,
        {
          method: 'DELETE',
          headers: { 'x-team-member-id': user.team_member_id },
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to unsnooze');
        return;
      }
      toast.success('Unsnoozed');
      window.dispatchEvent(
        new CustomEvent('inbox:snoozed', {
          detail: { threadId, snoozed_until: null },
        })
      );
      setOpen(false);
    } catch {
      toast.error('Failed to unsnooze');
    } finally {
      setSubmitting(false);
    }
  }, [user, threadId]);

  const onCustomSubmit = useCallback(() => {
    if (!customValue) {
      toast.error('Pick a date and time');
      return;
    }
    // <input type="datetime-local"> gives us a naive local wall-clock string
    // (e.g. "2026-04-18T15:30"). Interpret it as PT (the founders are all PT),
    // rather than relying on the viewer's browser timezone.
    const date = fromZonedTime(customValue, TZ);
    void sendSnooze(date);
  }, [customValue, sendSnooze]);

  // If the popover closes, return focus to the trigger for keyboard UX.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && lastTriggerRef.current) {
      try {
        lastTriggerRef.current.focus();
      } catch {
        /* ignore */
      }
    }
  };

  if (!open || !threadId) return null;

  const useBackdrop = !anchor;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      {/* Controlled anchor: tie the positioner to the DOM trigger if present.
          When there's no trigger element we fall back to centered positioning. */}
      {anchor ? (
        <PopoverPrimitive.Trigger
          nativeButton={false}
          render={<span />}
          // Base UI uses the Trigger as the reference element for positioning.
          // We render a 0-interaction invisible span placed directly over the
          // real snooze button so the popover anchors correctly regardless of
          // scroll/layout.
          style={positionOverAnchor(anchor)}
          aria-hidden
        />
      ) : null}
      <PopoverPrimitive.Portal>
        {useBackdrop && (
          <PopoverPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/10" />
        )}
        <PopoverPrimitive.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          className={cn(
            'isolate z-50',
            useBackdrop &&
              'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
          )}
        >
          <PopoverPrimitive.Popup
            data-slot="snooze-popover"
            className="z-50 flex w-72 flex-col gap-2 rounded-lg bg-white p-2.5 text-sm text-gray-900 shadow-lg ring-1 ring-black/10 outline-none"
          >
            <div className="flex items-center justify-between px-1 pb-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                <Clock className="h-3.5 w-3.5" />
                Snooze until
              </div>
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex flex-col gap-1">
              {presets.map(p => {
                const when = p.compute();
                const disabled = !when;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled || submitting}
                    onClick={() => when && void sendSnooze(when)}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors',
                      disabled
                        ? 'cursor-not-allowed text-gray-300'
                        : 'hover:border-gray-200 hover:bg-gray-50'
                    )}
                  >
                    <span className="flex flex-col">
                      <span className="font-medium text-gray-800">
                        {p.label}
                      </span>
                      <span className="text-[10px] text-gray-500">{p.sub}</span>
                    </span>
                    {when && (
                      <span className="text-[10px] text-gray-400">
                        {formatInTimeZone(when, TZ, 'EEE h:mm a')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="border-t border-gray-100 pt-2">
              <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                <Calendar className="h-3 w-3" />
                Custom (PT)
              </div>
              <div className="flex items-center gap-1.5 px-1">
                <input
                  type="datetime-local"
                  value={customValue}
                  onChange={e => setCustomValue(e.target.value)}
                  className="flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-gray-400"
                />
                <button
                  type="button"
                  onClick={onCustomSubmit}
                  disabled={submitting || !customValue}
                  className="rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  Snooze
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-gray-100 pt-2">
              <button
                type="button"
                onClick={sendUnsnooze}
                disabled={submitting}
                className="text-[11px] text-gray-500 hover:text-gray-800 disabled:opacity-50"
              >
                Unsnooze
              </button>
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Returns inline styles that position a 0-size invisible span over the anchor
 * element. The Popover's Positioner uses this invisible Trigger as its
 * reference for floating placement.
 */
function positionOverAnchor(el: HTMLElement): React.CSSProperties {
  const r = el.getBoundingClientRect();
  return {
    position: 'fixed',
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    pointerEvents: 'none',
    opacity: 0,
  };
}
