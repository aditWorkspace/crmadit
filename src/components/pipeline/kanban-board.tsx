'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { useSession } from '@/hooks/use-session';
import { Lead, LeadStage } from '@/types';
import { ACTIVE_STAGES, STAGE_LABELS } from '@/lib/constants';
import { KanbanColumn } from './kanban-column';
import { KanbanCard } from './kanban-card';
import { toast } from 'sonner';
import { useLeadRealtime } from '@/hooks/use-realtime';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { SkeletonKanban } from '@/components/ui/skeleton-cards';
import { LeadFormModal } from '@/components/leads/lead-form';
import { Kanban } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Kanban shows all active stages except paused (it's in ACTIVE_STAGES but not useful in Kanban)
const KANBAN_STAGES: LeadStage[] = ACTIVE_STAGES;

export function KanbanBoard() {
  const { user } = useSession();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [showAddLead, setShowAddLead] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 200, tolerance: 5 }, // hold 200ms to drag; quick clicks pass through
    })
  );

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    const res = await fetch(`/api/leads?${KANBAN_STAGES.map(s => `stage=${s}`).join('&')}&limit=200`, {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      const data = await res.json();
      setLeads(data.leads || []);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Realtime updates
  useLeadRealtime(fetchLeads);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onNewLead: () => setShowAddLead(true),
    onEscape: () => setShowAddLead(false),
  });

  const handleDragStart = (event: DragStartEvent) => {
    setActiveLeadId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveLeadId(null);
    const { active, over } = event;
    if (!over || !user) return;

    const leadId = active.id as string;
    const newStage = over.id as LeadStage;
    const lead = leads.find(l => l.id === leadId);

    if (!lead || lead.stage === newStage) return;

    // Optimistic update
    const prevLeads = leads;
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, stage: newStage } : l));

    const res = await fetch(`/api/leads/${leadId}/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-team-member-id': user.team_member_id,
      },
      body: JSON.stringify({ stage: newStage }),
    });

    const data = await res.json();
    if (!res.ok) {
      // Revert on failure
      setLeads(prevLeads);
      toast.error(data.error || `Cannot move to ${STAGE_LABELS[newStage]}`, {
        description: data.error?.includes('call date') ? 'Set a call date/time first.' : undefined,
      });
    } else {
      toast.success(`Moved to ${STAGE_LABELS[newStage]}`);
    }
  };

  const leadsByStage = KANBAN_STAGES.reduce<Record<string, Lead[]>>((acc, stage) => {
    acc[stage] = leads.filter(l => l.stage === stage);
    return acc;
  }, {});

  const activeLead = leads.find(l => l.id === activeLeadId);

  if (loading) {
    return <SkeletonKanban columns={KANBAN_STAGES.length} cardsPerColumn={3} />;
  }

  const totalLeads = leads.length;

  return (
    <>
      {totalLeads === 0 && (
        <div className="flex flex-col items-center gap-4 py-24 text-center text-gray-400">
          <Kanban className="h-12 w-12 text-gray-200" />
          <div>
            <p className="font-medium text-gray-700">No leads in the pipeline</p>
            <p className="text-sm mt-1">Add a lead to get started — press <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 rounded border border-gray-200 font-mono">n</kbd> or click below.</p>
          </div>
          <Button size="sm" onClick={() => setShowAddLead(true)}>Add Lead</Button>
        </div>
      )}

      {totalLeads > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 pb-4 overflow-x-auto">
            {KANBAN_STAGES.map(stage => (
              <KanbanColumn
                key={stage}
                stage={stage}
                leads={leadsByStage[stage] || []}
                activeLeadId={activeLeadId}
              />
            ))}
          </div>

          {/* Drag overlay — the card that follows the cursor */}
          <DragOverlay>
            {activeLead ? (
              <div className="rotate-2 shadow-2xl">
                <KanbanCard lead={activeLead} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <LeadFormModal open={showAddLead} onClose={() => setShowAddLead(false)} onSuccess={fetchLeads} />
    </>
  );
}
