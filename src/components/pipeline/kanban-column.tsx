'use client';

import { useDroppable } from '@dnd-kit/core';
import { Lead, LeadStage } from '@/types';
import { STAGE_LABELS, STAGE_DOT_COLORS } from '@/lib/constants';
import { KanbanCard } from './kanban-card';
import { cn } from '@/lib/utils';

interface KanbanColumnProps {
  stage: LeadStage;
  leads: Lead[];
  activeLeadId: string | null;
}

export function KanbanColumn({ stage, leads, activeLeadId }: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });

  return (
    <div className="flex flex-col min-w-60 max-w-72 w-64 flex-shrink-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 mb-3">
        <span className={cn('h-2 w-2 rounded-full', STAGE_DOT_COLORS[stage])} />
        <h3 className="text-sm font-medium text-gray-700">{STAGE_LABELS[stage]}</h3>
        <span className="ml-auto text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
          {leads.length}
        </span>
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 rounded-xl p-2 space-y-2 min-h-24 transition-colors',
          isOver ? 'bg-blue-50 ring-2 ring-blue-200' : 'bg-gray-50/50',
        )}
      >
        {leads.map(lead => (
          <KanbanCard
            key={lead.id}
            lead={lead}
            isDragging={lead.id === activeLeadId}
          />
        ))}
        {leads.length === 0 && (
          <div className="h-16 flex items-center justify-center text-xs text-gray-300">
            Drop here
          </div>
        )}
      </div>
    </div>
  );
}
