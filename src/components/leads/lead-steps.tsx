'use client';

import { Lead, LeadStage } from '@/types';
import { ACTIVE_STAGES, STAGE_LABELS } from '@/lib/constants';
import { formatDate, cn } from '@/lib/utils';
import { Check } from 'lucide-react';

interface LeadStepsProps {
  lead: Lead;
  onStageChange: (stage: LeadStage) => Promise<void>;
  onDateChange: (field: string, value: string) => Promise<void>;
}

const STAGE_DATE_FIELDS: Partial<Record<LeadStage, keyof Lead>> = {
  replied: 'first_reply_at',
  scheduled: 'call_scheduled_for',
  call_completed: 'call_completed_at',
  demo_sent: 'demo_sent_at',
  active_user: 'product_access_granted_at',
};

type DisplayStage = Exclude<LeadStage, 'paused'>;

export function LeadSteps({ lead, onStageChange, onDateChange }: LeadStepsProps) {
  const displayStages = ACTIVE_STAGES.filter((s): s is DisplayStage => s !== 'paused');
  const currentIdx = displayStages.indexOf(lead.stage as DisplayStage);

  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50/50 border-b border-gray-100">
        <h3 className="text-sm font-medium text-gray-700">Pipeline Progress</h3>
      </div>
      <div className="divide-y divide-gray-50">
        {displayStages.map((stage, idx) => {
          const isCompleted = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const isPending = idx > currentIdx;
          const dateField = STAGE_DATE_FIELDS[stage];
          const dateValue = dateField ? (lead[dateField] as string | undefined) : undefined;

          return (
            <div key={stage} className={cn(
              'flex items-center gap-4 px-4 py-3',
              isCurrent && 'bg-blue-50/30',
            )}>
              <div className="flex-shrink-0">
                {isCompleted ? (
                  <div className="h-6 w-6 rounded-full bg-gray-900 flex items-center justify-center">
                    <Check className="h-3.5 w-3.5 text-white" />
                  </div>
                ) : isCurrent ? (
                  <div className="h-6 w-6 rounded-full border-2 border-blue-500 flex items-center justify-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  </div>
                ) : (
                  <div className="h-6 w-6 rounded-full border-2 border-gray-200 flex items-center justify-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-gray-200" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <button
                  onClick={() => isPending && onStageChange(stage)}
                  className={cn(
                    'text-sm font-medium',
                    isCompleted && 'text-gray-500',
                    isCurrent && 'text-blue-700',
                    isPending && 'text-gray-400 hover:text-gray-600 cursor-pointer'
                  )}
                  disabled={isCompleted || isCurrent}
                >
                  {STAGE_LABELS[stage]}
                </button>
              </div>

              <div className="flex items-center gap-4 text-xs text-gray-400">
                {dateField && dateValue ? (
                  <input
                    type="datetime-local"
                    defaultValue={new Date(dateValue).toISOString().slice(0, 16)}
                    onChange={e => onDateChange(dateField as string, e.target.value)}
                    className="text-xs text-gray-500 border-none bg-transparent cursor-pointer hover:text-gray-700 focus:outline-none focus:text-gray-700"
                    title="Click to edit date"
                  />
                ) : dateField ? (
                  <input
                    type="datetime-local"
                    onChange={e => onDateChange(dateField as string, e.target.value)}
                    className="text-xs text-gray-400 border-none bg-transparent cursor-pointer hover:text-gray-600 focus:outline-none"
                    placeholder="Set date"
                  />
                ) : (
                  <span>—</span>
                )}
                {(isCompleted || isCurrent) && <Check className="h-3.5 w-3.5 text-gray-400" />}
              </div>
            </div>
          );
        })}
      </div>

      {(lead.stage === 'paused' || lead.stage === 'dead') && (
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-sm text-gray-500">
          Stage: <span className="font-medium capitalize">{lead.stage}</span>
          {lead.paused_until && ` — resumes ${formatDate(lead.paused_until)}`}
        </div>
      )}
    </div>
  );
}
