'use client';

import Link from 'next/link';
import { AlertTriangle } from '@/lib/icons';

interface StaleAlertBannerProps {
  staleCount: number;
}

export function StaleAlertBanner({ staleCount }: StaleAlertBannerProps) {
  if (staleCount === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
      <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
      <p className="text-sm text-red-700 flex-1">
        <span className="font-semibold">{staleCount} lead{staleCount > 1 ? 's are' : ' is'} stale</span>
        {' '}— no contact within their expected window.
      </p>
      <Link href="/leads?preset=stale" className="text-sm font-medium text-red-700 hover:text-red-900 underline flex-shrink-0">
        View →
      </Link>
    </div>
  );
}
