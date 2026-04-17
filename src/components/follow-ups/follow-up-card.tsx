'use client';

import { useState } from 'react';
import { FollowUp } from '@/types';
import { formatRelativeTime, formatDate, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Clock, CheckCheck, X, ChevronDown, Copy, AlertCircle } from '@/lib/icons';
import Link from 'next/link';

interface FollowUpCardProps {
  followUp: FollowUp;
  onUpdate: (id: string, action: string, params?: Record<string, unknown>) => Promise<void>;
}

export function FollowUpCard({ followUp, onUpdate }: FollowUpCardProps) {
  const [loading, setLoading] = useState<string | null>(null);

  const isOverdue = new Date(followUp.due_at) < new Date();
  const lead = followUp.lead as { id: string; contact_name: string; company_name: string } | undefined;

  const handle = async (action: string, params?: Record<string, unknown>) => {
    setLoading(action);
    try {
      await onUpdate(followUp.id, action, params);
    } finally {
      setLoading(null);
    }
  };

  const copyMessage = () => {
    if (!followUp.suggested_message) return;
    navigator.clipboard.writeText(followUp.suggested_message);
    toast.success('Message copied to clipboard');
  };

  return (
    <div className={cn(
      'rounded-xl border bg-white p-4 space-y-3',
      isOverdue ? 'border-red-200' : 'border-gray-100',
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          {isOverdue && (
            <div className="flex items-center gap-1.5 text-xs text-red-600 font-medium mb-1.5">
              <AlertCircle className="h-3.5 w-3.5" />
              OVERDUE · {formatRelativeTime(followUp.due_at)}
            </div>
          )}
          {!isOverdue && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1.5">
              <Clock className="h-3.5 w-3.5" />
              Due {formatRelativeTime(followUp.due_at)}
            </div>
          )}
          <p className="text-sm font-medium text-gray-900">
            {lead ? (
              <Link href={`/leads/${lead.id}`} className="hover:text-blue-600">
                {lead.contact_name} at {lead.company_name}
              </Link>
            ) : 'Unknown lead'}
          </p>
          {followUp.reason && (
            <p className="text-xs text-gray-500 mt-0.5">{followUp.reason}</p>
          )}
        </div>
        <span className="text-xs text-gray-400 flex-shrink-0 capitalize">
          {followUp.type.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Suggested message */}
      {followUp.suggested_message && (
        <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700 italic">
          &ldquo;{followUp.suggested_message}&rdquo;
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {followUp.suggested_message && (
          <Button variant="outline" size="sm" onClick={copyMessage} className="gap-1.5 h-8">
            <Copy className="h-3.5 w-3.5" />
            Copy Message
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => handle('complete')}
          disabled={loading === 'complete'}
          className="gap-1.5 h-8"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          Mark Done
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1 h-8 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted transition-colors">
            Snooze <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handle('snooze', { snooze_days: 1 })}>1 day</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handle('snooze', { snooze_days: 3 })}>3 days</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handle('snooze', { snooze_days: 7 })}>1 week</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => handle('dismiss')}
          disabled={loading === 'dismiss'}
          className="gap-1.5 h-8 text-gray-400 hover:text-gray-600 ml-auto"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}
