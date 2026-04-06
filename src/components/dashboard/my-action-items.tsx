'use client';

import { ActionItem } from '@/types';
import { formatDate, cn } from '@/lib/utils';
import { useSession } from '@/hooks/use-session';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import Link from 'next/link';

interface MyActionItemsProps {
  items: ActionItem[];
  onComplete: (id: string) => void;
}

export function MyActionItems({ items, onComplete }: MyActionItemsProps) {
  const { user } = useSession();

  const handleComplete = async (id: string) => {
    if (!user) return;
    const res = await fetch(`/api/action-items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-team-member-id': user.team_member_id },
      body: JSON.stringify({ completed: true }),
    });
    if (res.ok) {
      onComplete(id);
      toast.success('Action item completed');
    } else {
      toast.error('Failed to complete');
    }
  };

  if (items.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No pending action items. Nice work!</p>;
  }

  return (
    <div className="space-y-1">
      {items.map(item => {
        const isOverdue = item.due_date && new Date(item.due_date) < new Date();
        const lead = item.lead as { id: string; contact_name: string; company_name: string } | undefined;
        return (
          <div key={item.id} className={cn(
            'flex items-start gap-3 py-2 px-2 rounded-lg group hover:bg-gray-50',
            isOverdue && 'bg-red-50/50'
          )}>
            <Checkbox
              checked={false}
              onCheckedChange={() => handleComplete(item.id)}
              className="mt-0.5 flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm', isOverdue ? 'text-red-700' : 'text-gray-700')}>{item.text}</p>
              {lead && (
                <Link href={`/leads/${lead.id}`} className="text-xs text-blue-500 hover:underline">
                  {lead.contact_name} · {lead.company_name}
                </Link>
              )}
            </div>
            {item.due_date && (
              <span className={cn('text-xs flex-shrink-0', isOverdue ? 'text-red-500 font-medium' : 'text-gray-400')}>
                {isOverdue ? 'Overdue' : formatDate(item.due_date)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
