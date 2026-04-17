'use client';

import { useState } from 'react';
import { ActionItem, TeamMember } from '@/types';
import { ActionItemRow } from './action-item-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus } from '@/lib/icons';

interface ActionItemListProps {
  leadId: string;
  items: ActionItem[];
  members: TeamMember[];
  memberId: string;
  onAdd: (text: string) => Promise<void>;
  onUpdate: (id: string, updates: Partial<ActionItem>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ActionItemList({ leadId: _leadId, items, members, memberId: _memberId, onAdd, onUpdate, onDelete }: ActionItemListProps) {
  const [newText, setNewText] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const pending = items.filter(i => !i.completed);
  const completed = items.filter(i => i.completed);

  const handleAdd = async () => {
    if (!newText.trim()) return;
    setAdding(true);
    await onAdd(newText.trim());
    setNewText('');
    setAdding(false);
    setShowAdd(false);
  };

  return (
    <div className="space-y-1">
      {pending.map(item => (
        <ActionItemRow key={item.id} item={item} members={members} onUpdate={onUpdate} onDelete={onDelete} />
      ))}

      {completed.length > 0 && (
        <div className="pt-1">
          <p className="text-xs text-gray-400 px-1 mb-1">{completed.length} completed</p>
          {completed.map(item => (
            <ActionItemRow key={item.id} item={item} members={members} onUpdate={onUpdate} onDelete={onDelete} />
          ))}
        </div>
      )}

      {showAdd ? (
        <div className="flex gap-2 pt-1">
          <Input
            autoFocus
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') setShowAdd(false);
            }}
            placeholder="Action item text..."
            className="flex-1 h-8 text-sm"
          />
          <Button size="sm" onClick={handleAdd} disabled={adding || !newText.trim()} className="h-8">
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)} className="h-8">
            Cancel
          </Button>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 pt-1 pl-1 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add action item
        </button>
      )}
    </div>
  );
}
