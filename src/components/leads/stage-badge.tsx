'use client';

import { LeadStage } from '@/types';
import { STAGE_COLORS, STAGE_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface StageBadgeProps {
  stage: LeadStage;
  className?: string;
}

export function StageBadge({ stage, className }: StageBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STAGE_COLORS[stage],
        className
      )}
    >
      {STAGE_LABELS[stage]}
    </span>
  );
}
