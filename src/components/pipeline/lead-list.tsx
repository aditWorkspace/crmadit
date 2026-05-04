'use client';

import { cn } from '@/lib/utils';
import { stripHtml } from '@/lib/utils';
import { STAGE_LABELS, STAGE_COLORS, STALE_THRESHOLDS, PRIORITY_COLORS } from '@/lib/constants';
import { LeadStage, Priority } from '@/types';
import { AlertCircle, Phone, Clock, Users, Repeat, ArrowUpRight, ArrowDownLeft, Search } from '@/lib/icons';
import { useState, useMemo, useEffect } from 'react';

export interface PipelineLead {
  id: string;
  contact_name: string;
  company_name: string;
  stage: LeadStage;
  priority: string;
  last_contact_at: string | null;
  ai_next_action: string | null;
  call_scheduled_for: string | null;
  call_prep_status: string | null;
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

const GROUP_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  needs_attention: { label: 'Needs Attention', icon: AlertCircle, color: 'text-red-600' },
  calls: { label: 'Upcoming Calls', icon: Phone, color: 'text-indigo-600' },
  active: { label: 'Active', icon: Clock, color: 'text-gray-500' },
  long_term: { label: 'Long Term', icon: Repeat, color: 'text-gray-400' },
  paused: { label: 'Paused', icon: Users, color: 'text-gray-400' },
};

const OWNER_COLORS: Record<string, string> = {
  Srijay: 'bg-emerald-500',
  Adit: 'bg-blue-500',
  Asim: 'bg-violet-500',
};

function timeAgo(dateStr: string): { label: string; color: string } {
  const hrs = (Date.now() - new Date(dateStr).getTime()) / 3600000;
  if (hrs < 0) {
    const abs = Math.abs(hrs);
    if (abs < 1) return { label: `in ${Math.round(abs * 60)}m`, color: 'text-blue-500' };
    if (abs < 24) return { label: `in ${Math.round(abs)}h`, color: 'text-blue-500' };
    return { label: `in ${Math.round(abs / 24)}d`, color: 'text-blue-500' };
  }
  if (hrs < 1) return { label: `${Math.round(hrs * 60)}m`, color: 'text-green-600' };
  if (hrs < 2) return { label: `${Math.round(hrs)}h`, color: 'text-green-600' };
  if (hrs < 8) return { label: `${Math.round(hrs)}h`, color: 'text-yellow-600' };
  if (hrs < 24) return { label: `${Math.round(hrs)}h`, color: 'text-orange-500' };
  const days = Math.round(hrs / 24);
  return { label: `${days}d`, color: days > 7 ? 'text-red-500' : 'text-red-400' };
}

function formatCallTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffHrs = diffMs / 3600000;

  if (diffHrs < 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diffHrs < 24) return `Today at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (diffHrs < 48) return `Tomorrow at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    ? stripHtml(lead.last_interaction.summary || lead.last_interaction.body || '').slice(0, 60)
    : null;

  const isInbound = lead.last_interaction?.type === 'email_inbound';
  const ownerName = (lead.owned_by_member as { name: string } | null)?.name;
  const ownerColor = ownerName ? OWNER_COLORS[ownerName] || 'bg-gray-400' : 'bg-gray-400';

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-gray-50 transition-all group',
        selected
          ? 'bg-blue-50 border-l-[3px] border-l-blue-500'
          : 'hover:bg-gray-50/80 border-l-[3px] border-l-transparent',
        stale && !selected && 'bg-red-50/30 hover:bg-red-50/50'
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Owner dot + priority indicator */}
        <div className="flex flex-col items-center gap-1 flex-shrink-0">
          <div className={cn('h-2 w-2 rounded-full', ownerColor)} title={ownerName || 'Unassigned'} />
          <div className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_COLORS[lead.priority as Priority])} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Name + Company + Time */}
          <div className="flex items-center gap-1.5">
            <span className={cn(
              'text-[13px] font-semibold truncate',
              selected ? 'text-blue-900' : 'text-gray-900'
            )}>
              {lead.contact_name}
            </span>
            <span className="text-[11px] text-gray-400 truncate flex-shrink-[2]">
              {lead.company_name}
            </span>
            <span className="ml-auto flex items-center gap-1 flex-shrink-0">
              {time && (
                <span className={cn('text-[11px] font-medium tabular-nums', time.color)}>
                  {time.label}
                </span>
              )}
            </span>
          </div>

          {/* Call time for scheduled leads */}
          {lead.stage === 'scheduled' && lead.call_scheduled_for && (
            <div className="flex items-center gap-1 mt-0.5">
              <Phone className="h-3 w-3 text-blue-400" />
              <span className="text-[11px] font-medium text-blue-600">
                {formatCallTime(lead.call_scheduled_for)}
              </span>
              {lead.call_prep_status === 'completed' && (
                <span className="text-[10px] text-green-600 bg-green-50 px-1.5 py-[1px] rounded-full">Prep ready</span>
              )}
              {lead.call_prep_status === 'generating' && (
                <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-[1px] rounded-full">Generating...</span>
              )}
            </div>
          )}

          {/* Row 2: Stage pill + direction arrow + preview */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={cn(
              'text-[10px] px-1.5 py-[1px] rounded-full border flex-shrink-0 font-medium',
              STAGE_COLORS[lead.stage]
            )}>
              {STAGE_LABELS[lead.stage]}
            </span>
            {lead.last_interaction && (
              <>
                {isInbound ? (
                  <ArrowDownLeft className="h-3 w-3 text-blue-400 flex-shrink-0" />
                ) : (
                  <ArrowUpRight className="h-3 w-3 text-gray-300 flex-shrink-0" />
                )}
                <span className="text-[11px] text-gray-400 truncate">
                  {preview}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

const GROUP_ORDER = ['needs_attention', 'calls', 'active', 'long_term', 'paused'] as const;

export function LeadList({ leads, selectedId, filter, onFilterChange, onSelect }: LeadListProps) {
  const [search, setSearch] = useState('');
  const [departedNames, setDepartedNames] = useState<Set<string>>(new Set());

  // Fetch which founders have departed so the owner legend can render
  // them as grayed-out (D3-b: show but mark as departed).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/team/departed')
      .then(r => (r.ok ? r.json() : { departed: [] }))
      .then((data: { departed: Array<{ name: string }> }) => {
        if (!cancelled) setDepartedNames(new Set((data.departed ?? []).map(m => m.name)));
      })
      .catch(() => { /* fail-open: legend just shows everyone normally */ });
    return () => { cancelled = true; };
  }, []);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return leads;
    const q = search.toLowerCase();
    return leads.filter(l =>
      l.contact_name.toLowerCase().includes(q) ||
      l.company_name.toLowerCase().includes(q)
    );
  }, [leads, search]);

  // Group leads
  const groups = GROUP_ORDER.reduce<Record<string, PipelineLead[]>>((acc, g) => {
    acc[g] = filtered.filter(l => l.urgency_group === g);
    return acc;
  }, {} as Record<string, PipelineLead[]>);

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-gray-100 flex-shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Pipeline</h2>
            <p className="text-[11px] text-gray-400">{leads.length} leads</p>
          </div>
          {/* Owner legend. Departed founders are shown grayed out so historical
              attribution stays visible in the pipeline. */}
          <div className="flex items-center gap-2">
            {Object.entries(OWNER_COLORS).map(([name, color]) => {
              const isDeparted = departedNames.has(name);
              return (
                <div
                  key={name}
                  className={cn('flex items-center gap-1', isDeparted && 'opacity-40')}
                  title={isDeparted ? `${name} (departed — leads frozen)` : name}
                >
                  <div className={cn('h-2 w-2 rounded-full', color)} />
                  <span className={cn('text-[10px]', isDeparted ? 'text-gray-300 line-through' : 'text-gray-400')}>{name[0]}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-300" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search leads..."
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-gray-50 border border-gray-100 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-300 focus:bg-white transition-colors placeholder:text-gray-300"
          />
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-gray-100 flex-shrink-0">
        {FILTER_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onFilterChange(key)}
            className={cn(
              'flex-1 text-[11px] py-2 font-medium transition-colors',
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
        {filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-400">
            {search ? 'No matching leads.' : 'No active leads in this view.'}
          </div>
        )}

        {GROUP_ORDER.map((groupKey) => {
          const groupLeads = groups[groupKey];
          if (!groupLeads || !groupLeads.length) return null;
          const { label, icon: Icon, color } = GROUP_META[groupKey];

          return (
            <div key={groupKey}>
              {/* Section header */}
              <div className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-50 sticky top-0 z-10',
                groupKey === 'needs_attention' ? 'bg-red-50/80' : 'bg-gray-50/80',
                'backdrop-blur-sm'
              )}>
                <Icon className={cn('h-3 w-3', color)} />
                <span className={cn('text-[11px] font-semibold uppercase tracking-wider', color)}>
                  {label}
                </span>
                <span className={cn('ml-auto text-[11px] font-semibold', color)}>
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
