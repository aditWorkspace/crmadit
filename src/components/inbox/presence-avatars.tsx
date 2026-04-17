'use client';

import { ownerColor } from '@/lib/colors';
import { cn } from '@/lib/utils';
import type { ThreadViewer } from '@/hooks/use-thread-presence';

interface PresenceAvatarsProps {
  viewers: ThreadViewer[];
  max?: number;
  className?: string;
}

function initials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

/**
 * Stacked, slightly overlapping 20px circles showing members currently
 * viewing the same thread. Hidden (renders null) when there are no viewers.
 */
export function PresenceAvatars({
  viewers,
  max = 4,
  className,
}: PresenceAvatarsProps) {
  if (!viewers || viewers.length === 0) return null;
  const visible = viewers.slice(0, max);
  const extra = viewers.length - visible.length;

  return (
    <div
      className={cn('flex items-center -space-x-1.5', className)}
      aria-label={`${viewers.length} viewing this thread`}
    >
      {visible.map(v => {
        const oc = ownerColor(v.name);
        return (
          <span
            key={v.memberId}
            title={`${v.name} is viewing`}
            className={cn(
              'relative inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-white',
              oc.bg,
              oc.text
            )}
          >
            {initials(v.name)}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-600 ring-2 ring-white"
          title={`${extra} more viewing`}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
