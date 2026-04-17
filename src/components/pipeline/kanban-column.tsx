'use client';

import { useDroppable } from '@dnd-kit/core';
import { Download } from '@/lib/icons';
import { Lead, LeadStage } from '@/types';
import { STAGE_LABELS, STAGE_DOT_COLORS } from '@/lib/constants';
import { KanbanCard } from './kanban-card';
import { cn } from '@/lib/utils';

interface KanbanColumnProps {
  stage: LeadStage;
  leads: Lead[];
  activeLeadId: string | null;
}

function downloadColumnCsv(stage: LeadStage, leads: Lead[]) {
  if (leads.length === 0) return;

  // Sort by call_completed_at (or last_contact_at, or created_at) descending
  const sorted = [...leads].sort((a, b) => {
    const dateA = a.call_completed_at || a.last_contact_at || a.created_at;
    const dateB = b.call_completed_at || b.last_contact_at || b.created_at;
    return new Date(dateB).getTime() - new Date(dateA).getTime();
  });

  const rows = sorted.map(lead => {
    const fullName = lead.contact_name || '';
    const firstName = fullName.split(/\s+/)[0] || '';
    const email = lead.contact_email || '';
    const callDate = lead.call_completed_at || lead.last_contact_at || '';
    const formatted = callDate ? new Date(callDate).toLocaleDateString('en-US') : '';
    return [fullName, firstName, email, formatted];
  });

  const header = ['Full Name', 'First Name', 'Email', 'Date'];
  const csv = [header, ...rows]
    .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${STAGE_LABELS[stage].replace(/\s+/g, '_').toLowerCase()}_leads.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function KanbanColumn({ stage, leads, activeLeadId }: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });

  return (
    <div className="flex flex-col min-w-60 max-w-72 w-64 flex-shrink-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 mb-3">
        <span className={cn('h-2 w-2 rounded-full', STAGE_DOT_COLORS[stage])} />
        <h3 className="text-sm font-medium text-gray-700">{STAGE_LABELS[stage]}</h3>
        <div className="ml-auto flex items-center gap-1.5">
          {leads.length > 0 && (
            <button
              onClick={() => downloadColumnCsv(stage, leads)}
              title="Download CSV"
              className="text-gray-300 hover:text-gray-500 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
            {leads.length}
          </span>
        </div>
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
