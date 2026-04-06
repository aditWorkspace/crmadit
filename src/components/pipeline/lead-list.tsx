'use client';

import { cn } from '@/lib/utils';
import { stripHtml } from '@/lib/utils';
import { STAGE_LABELS, STAGE_COLORS, STALE_THRESHOLDS } from '@/lib/constants';
import { LeadStage } from '@/types';
import { AlertCircle, Phone, Clock, Users, Repeat } from 'lucide-react';

export interface PipelineLead {
  id: string;
  contact_name: string;
  company_name: string;
  stage: LeadStage;
  priority: string;
  last_contact_at: string | null;
  ai_next_action: string | null;
  call_scheduled_for: string | null;
  owned_by: string;
  urgency_group: 'needs_attention' | 'calls' | 'active' | 'long_term' | 'paused';
  last_interaction: {
    type: string;
    body: string | null;
    summary: string | null;
    occurred_at: string;
  } | null;
  latest_thread: { threadId: string; subject: string } | null;
  owned_by_member: { id: string; name: string } | null;
}

type FilterTab = 'all' | 'mine' | 'calls' | 'demos' | 'weekly';

interface LeadListProps {
  leads: PipelineLead[];
  selectedId: string | null;
  filter: FilterTab;
  onFilterChange: (f: FilterTab) => void;
  onSelect: (id: string) => void;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'calls', label: 'Calls' },
  { key: 'demos', label: 'Demos' },
  { key: 'weekly', label: 'Weekly' },
];

const GROUP_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  needs_attention: { label: 'Needs Attention', icon: AlertCircle },
  calls: { label: 'Calls', icon: Phone },
  active: { label: 'Active', icon: Clock },
  long_term: { label: 'Long Term', icon: Repeat },
  paused: { label: 'Paused', icon: Users },
};

function timeAgo(dateStr: string): { label: string; color: string } {
  const hrs = (Date.now() - new Date(dateStr).getTime()) / 3600000;
  if (hrs < 1) return { label: `${Math.round(hrs * 60)}m`, color: 'text-green-600' };
  if (hrs < 2) return { label: `${Math.round(hrs)}h`, color: 'text-green-600' };
  if (hrs < 8) return { label: `${Math.round(hrs)}h`, color: 'text-yellow-600' };
  if (hrs < 24) return { label: `${Math.round(hrs)}h`, color: 'text-orange-500' };
  const days = Math.round(hrs / 24);
  return { label: `${days}d`, color: 'text-red-500' };
}

function isStale(stage: LeadStage, lastContactAt: string | null): boolean {
  if (!lastContactAt) return false;
  const threshold = STALE_THRESHOLDS[stage];
  if (!threshold) return false;
  const hrs = (Date.now() - new Date(lastContactAt).getTime()) / 3600000;
  return hrs > threshold;
}

function LeadItem({ lead, selected, onSelect }: { lead: PipelineLead; selected: boolean; onSelect: () => void }) {
  const stale = isStale(lead.stage, lead.last_contact_at);
  const time = lead.last_contact_at ? timeAgo(lead.last_contact_at) : null;
  const preview = lead.last_interaction
    ? stripHtml(lead.last_interaction.summary || lead.last_interaction.body || '').slice(0, 80)
    : null;

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-gray-100 transition-colors',
        selected
          ? 'bg-blue-50 border-l-2 border-l-blue-500'
          : 'hover:bg-gray-50 border-l-2 border-l-transparent',
        stale && !selected && 'bg-red-50/40 hover:bg-red-50/60'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className={cn(
          'h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 mt-0.5',
          selected ? 'bg-blue-600 text-white' : 'bg-gray-900 text-white'
        )}>
          {lead.contact_name[0]?.toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          {/* Row 1: name + time */}
          <div className="flex items-center justify-between gap-2">
            <span className={cn(
              'text-sm font-semibold truncate',
              selected ? 'text-blue-900' : 'text-gray-900'
            )}>
              {lead.contact_name}
            </span>
            {time && (
              <span className={cn('text-xs font-medium flex-shrink-0 tabular-nums', time.color)}>
                {time.label}
              </span>
            )}
          </div>

          {/* Row 2: company + stage */}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-gray-500 truncate">{lead.company_name}</span>
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded-full border flex-shrink-0',
              STAGE_COLORS[lead.stage]
            )}>
              {STAGE_LABELS[lead.stage]}
            </span>
          </div>

          {/* Row 3: last message preview */}
          {preview && (
            <p className="text-xs text-gray-400 mt-1 truncate leading-relaxed">
              {lead.last_interaction?.type === 'email_inbound' ? '← ' : '→ '}
              {preview}
            </p>
          )}

          {/* Row 4: AI action hint */}
          {lead.ai_next_action && (
            <p className="text-xs text-amber-600 mt-1 truncate">
              ✨ {lead.ai_next_action}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

const GROUP_ORDER = ['needs_attention', 'calls', 'active', 'long_term', 'paused'] as const;

export function LeadList({ leads, selectedId, filter, onFilterChange, onSelect }: LeadListProps) {
  // Group leads
  const groups = GROUP_ORDER.reduce<Record<string, PipelineLead[]>>((acc, g) => {
    acc[g] = leads.filter(l => l.urgency_group === g);
    return acc;
  }, {} as Record<string, PipelineLead[]>);

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-900">Pipeline</h2>
        <p className="text-xs text-gray-400 mt-0.5">{leads.length} active leads</p>
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-gray-100 flex-shrink-0">
        {FILTER_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onFilterChange(key)}
            className={cn(
              'flex-1 text-xs py-2.5 font-medium transition-colors',
              filter === key
                ? 'text-blue-600 border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-gray-600'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Lead list */}
      <div className="flex-1 overflow-y-auto">
        {leads.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-400">
            No active leads in this view.
          </div>
        )}

        {GROUP_ORDER.map((groupKey) => {
          const groupLeads = groups[groupKey];
          if (!groupLeads.length) return null;
          const { label, icon: Icon } = GROUP_META[groupKey];

          return (
            <div key={groupKey}>
              {/* Section header */}
              <div className={cn(
                'flex items-center gap-1.5 px-4 py-2 border-b border-gray-100 sticky top-0 z-10',
                groupKey === 'needs_attention' ? 'bg-red-50' : 'bg-gray-50'
              )}>
                <Icon className={cn(
                  'h-3 w-3',
                  groupKey === 'needs_attention' ? 'text-red-500' : 'text-gray-400'
                )} />
                <span className={cn(
                  'text-xs font-semibold uppercase tracking-wide',
                  groupKey === 'needs_attention' ? 'text-red-600' : 'text-gray-400'
                )}>
                  {label}
                </span>
                <span className={cn(
                  'ml-auto text-xs font-medium',
                  groupKey === 'needs_attention' ? 'text-red-500' : 'text-gray-400'
                )}>
                  {groupLeads.length}
                </span>
              </div>

              {groupLeads.map(lead => (
                <LeadItem
                  key={lead.id}
                  lead={lead}
                  selected={selectedId === lead.id}
                  onSelect={() => onSelect(lead.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
