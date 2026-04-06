'use client';

import { useState } from 'react';
import { ActionItem, TeamMember } from '@/types';
import { formatDate, cn } from '@/lib/utils';
import { Trash2, Calendar } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface ActionItemRowProps {
  item: ActionItem;
  members: TeamMember[];
  onUpdate: (id: string, updates: Partial<ActionItem>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ActionItemRow({ item, members, onUpdate, onDelete }: ActionItemRowProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const isOverdue = item.due_date && !item.completed && new Date(item.due_date) < new Date();

  const handleTextSave = async () => {
    if (text.trim() !== item.text) {
      await onUpdate(item.id, { text: text.trim() });
    }
    setEditing(false);
  };

  return (
    <div className={cn(
      'flex items-start gap-3 py-2 px-1 rounded group',
      item.completed && 'opacity-60',
      isOverdue && !item.completed && 'bg-red-50/50'
    )}>
      <Checkbox
        checked={item.completed}
        onCheckedChange={(checked) => onUpdate(item.id, { completed: !!checked })}
        className="mt-0.5 flex-shrink-0"
      />

      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={handleTextSave}
            onKeyDown={e => {
              if (e.key === 'Enter') handleTextSave();
              if (e.key === 'Escape') { setText(item.text); setEditing(false); }
            }}
            className="w-full text-sm border-b border-blue-400 outline-none bg-transparent pb-0.5"
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            className={cn(
              'text-sm cursor-text',
              item.completed ? 'line-through text-gray-400' : isOverdue ? 'text-red-700' : 'text-gray-700'
            )}
          >
            {item.text}
          </span>
        )}

        <div className="flex items-center gap-3 mt-1">
          {item.due_date && (
            <span className={cn(
              'flex items-center gap-1 text-xs',
              isOverdue && !item.completed ? 'text-red-500 font-medium' : 'text-gray-400'
            )}>
              <Calendar className="h-3 w-3" />
              {isOverdue && !item.completed ? 'Overdue · ' : ''}{formatDate(item.due_date)}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <Select
          value={item.assigned_to || 'unassigned'}
          onValueChange={(v: string | null) => { if (v !== null) onUpdate(item.id, { assigned_to: v === 'unassigned' ? undefined : v }); }}
        >
          <SelectTrigger className="h-6 w-24 text-xs border-gray-200">
            <SelectValue>
              {members.find(m => m.id === item.assigned_to)?.name || 'Assign'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {members.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <button onClick={() => onDelete(item.id)} className="text-gray-300 hover:text-red-500 transition-colors">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
