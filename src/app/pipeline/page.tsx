import { KanbanBoard } from '@/components/pipeline/kanban-board';

export default function PipelinePage() {
  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-8 py-5 flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Pipeline</h1>
        <p className="text-sm text-gray-500 mt-0.5">Drag cards to move leads between stages.</p>
      </div>
      <div className="flex-1 overflow-auto px-8 py-6">
        <KanbanBoard />
      </div>
    </div>
  );
}
