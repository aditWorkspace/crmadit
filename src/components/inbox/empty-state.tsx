'use client';

import { Mail } from '@/lib/icons';

interface EmptyStateProps {
  title?: string;
  subtitle?: string;
}

export function EmptyState({
  title = 'No thread selected',
  subtitle = 'Pick a thread from the list to read and reply.',
}: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-[color:var(--surface-muted)]/40">
      <Mail className="h-10 w-10 text-gray-300 mb-4" />
      <p className="text-sm font-medium text-gray-500">{title}</p>
      <p className="text-xs text-gray-400 mt-1 max-w-xs">{subtitle}</p>
    </div>
  );
}
