'use client';

import { formatRelativeTime, formatDateTime } from '@/lib/utils';

interface RelativeTimeProps {
  date: string | Date;
  className?: string;
}

export function RelativeTime({ date, className }: RelativeTimeProps) {
  if (!date) return null;
  return (
    <span title={formatDateTime(date)} className={className}>
      {formatRelativeTime(date)}
    </span>
  );
}
