'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { LeadList, PipelineLead } from './lead-list';
import { LeadPanel } from './lead-panel';
import { KanbanBoard } from './kanban-board';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Loader2, LayoutList, Kanban } from 'lucide-react';
import { cn } from '@/lib/utils';

type FilterTab = 'all' | 'mine' | 'calls' | 'demos' | 'weekly';
type ViewMode = 'list' | 'board';

function EmptyPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-gray-50/30">
      <LayoutList className="h-10 w-10 text-gray-200 mb-4" />
      <p className="text-sm font-medium text-gray-400">Select a lead to view the conversation</p>
      <p className="text-xs text-gray-300 mt-1">Or use the filter tabs to find what needs attention</p>
    </div>
  );
}

export function PipelineView() {
  const { user } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [leads, setLeads] = useState<PipelineLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'));
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [listWidth, setListWidth] = useState(320);

  // Restore persisted view mode on mount
  useEffect(() => {
    const stored = localStorage.getItem('proxi-pipeline-view') as ViewMode | null;
    if (stored === 'board') setViewMode('board');
  }, []);

  const setView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem('proxi-pipeline-view', mode);
  };

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    const res = await fetch(`/api/pipeline?filter=${filter}`, {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      const data = await res.json();
      setLeads(data.leads || []);
    }
    setLoading(false);
  }, [user, filter]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    router.replace(`/?id=${id}`, { scroll: false });
  };

  const handleClose = () => {
    setSelectedId(null);
    router.replace('/', { scroll: false });
  };

  const handleDelete = (id: string) => {
    setLeads(prev => prev.filter(l => l.id !== id));
    setSelectedId(null);
    router.replace('/', { scroll: false });
  };

  const handleFilterChange = (f: FilterTab) => {
    setFilter(f);
    setLoading(true);
  };

  if (loading && leads.length === 0 && viewMode === 'list') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* View toggle bar */}
      <div className="flex-shrink-0 flex items-center gap-1 px-3 pt-2 pb-0">
        <button
          onClick={() => setView('list')}
          className={cn(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors',
            viewMode === 'list'
              ? 'bg-gray-900 text-white'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
          )}
        >
          <LayoutList className="h-3.5 w-3.5" />
          List
        </button>
        <button
          onClick={() => setView('board')}
          className={cn(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors',
            viewMode === 'board'
              ? 'bg-gray-900 text-white'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
          )}
        >
          <Kanban className="h-3.5 w-3.5" />
          Board
        </button>
      </div>

      {viewMode === 'board' ? (
        <div className="flex-1 overflow-auto px-4 py-3">
          <KanbanBoard />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel — resizable lead list */}
          <div style={{ width: listWidth }} className="flex-shrink-0">
            <LeadList
              leads={leads}
              selectedId={selectedId}
              filter={filter}
              onFilterChange={handleFilterChange}
              onSelect={handleSelect}
            />
          </div>

          <ResizeHandle
            storageKey="proxi-leadlist-width"
            defaultWidth={320}
            minWidth={240}
            maxWidth={480}
            onResize={setListWidth}
          />

          {/* Right panel */}
          {selectedId ? (
            <LeadPanel
              key={selectedId}
              leadId={selectedId}
              onClose={handleClose}
              onDelete={handleDelete}
            />
          ) : (
            <EmptyPanel />
          )}
        </div>
      )}
    </div>
  );
}
