'use client';

import { LeadStage } from '@/types';
import { STAGE_LABELS, STAGE_DOT_COLORS, ACTIVE_STAGES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import Link from 'next/link';

interface PipelineOverviewProps {
  stageCounts: Record<string, number>;
  totalActive: number;
}

export function PipelineOverview({ stageCounts, totalActive }: PipelineOverviewProps) {
  return (
    <div className="space-y-1.5">
      {ACTIVE_STAGES.map(stage => {
        const count = stageCounts[stage] || 0;
        const pct = totalActive > 0 ? (count / totalActive) * 100 : 0;
        return (
          <Link
            key={stage}
            href={`/leads?stage=${stage}`}
            className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-gray-50 group"
          >
            <span className={cn('h-2 w-2 rounded-full flex-shrink-0', STAGE_DOT_COLORS[stage as LeadStage])} />
            <span className="text-sm text-gray-600 flex-1">{STAGE_LABELS[stage as LeadStage]}</span>
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={cn('h-full rounded-full', STAGE_DOT_COLORS[stage as LeadStage])}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-sm font-medium text-gray-700 w-4 text-right">{count}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
