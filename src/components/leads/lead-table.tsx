'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { Lead, TeamMember, LeadStage, Priority } from '@/types';
import { StageBadge } from './stage-badge';
import { LeadFormModal } from './lead-form';
import { STAGE_LABELS, PRIORITY_COLORS, PRIORITY_LABELS, ACTIVE_STAGES } from '@/lib/constants';
import { formatRelativeTime, formatDateTime, cn } from '@/lib/utils';
import { differenceInDays } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { SkeletonTable } from '@/components/ui/skeleton-table';
import { useLeadRealtime } from '@/hooks/use-realtime';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
  Users,
  BellOff,
  Clock,
} from 'lucide-react';

type Preset = 'all' | 'my_leads' | 'awaiting_response' | 'awaiting_demo' | 'stale' | 'calls' | 'snoozed';
type SortDir = 'asc' | 'desc';

const PRESET_LABELS: Record<Preset, string> = {
  all: 'All',
  my_leads: 'My Leads',
  awaiting_response: 'Awaiting Response',
  awaiting_demo: 'Awaiting Demo',
  stale: 'Stale',
  calls: 'Calls',
  snoozed: 'Snoozed (OOO)',
};

export function LeadTable() {
  const { user } = useSession();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [showAddLead, setShowAddLead] = useState(false);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filters
  const [preset, setPreset] = useState<Preset>('all');
  const [search, setSearch] = useState('');
  const [selectedStages, setSelectedStages] = useState<LeadStage[]>([]);
  const [selectedPriority, setSelectedPriority] = useState('');
  const [selectedOwner, setSelectedOwner] = useState('');
  const [sortBy, setSortBy] = useState('updated_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const limit = 50;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  useEffect(() => {
    createClient()
      .from('team_members')
      .select('id, name, email, gmail_connected, created_at')
      .then(({ data }) => setMembers((data as TeamMember[]) || []));
  }, []);

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (preset !== 'all') params.set('preset', preset);
    if (debouncedSearch) params.set('q', debouncedSearch);
    selectedStages.forEach((s) => params.append('stage', s));
    if (selectedPriority) params.set('priority', selectedPriority);
    if (selectedOwner) params.set('owned_by', selectedOwner);
    params.set('sort_by', sortBy);
    params.set('sort_dir', sortDir);
    params.set('page', String(page));
    params.set('limit', String(limit));

    const res = await fetch(`/api/leads?${params}`, {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      const data = await res.json();
      setLeads(data.leads || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [user, preset, debouncedSearch, selectedStages, selectedPriority, selectedOwner, sortBy, sortDir, page]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // Realtime updates
  useLeadRealtime(fetchLeads, 'leads-table');

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onNewLead: () => setShowAddLead(true),
    onSearch: () => searchInputRef.current?.focus(),
    onEscape: () => {
      setShowAddLead(false);
      setSelectedIds(new Set());
    },
  });

  const handleSort = (col: string) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <ChevronsUpDown className="h-3.5 w-3.5 text-gray-300" />;
    return sortDir === 'asc' ? (
      <ChevronUp className="h-3.5 w-3.5" />
    ) : (
      <ChevronDown className="h-3.5 w-3.5" />
    );
  };

  const handleStageChange = async (leadId: string, stage: LeadStage) => {
    if (!user) return;
    const res = await fetch(`/api/leads/${leadId}/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-team-member-id': user.team_member_id,
      },
      body: JSON.stringify({ stage }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Failed to change stage');
      return;
    }
    toast.success(`Stage changed to ${STAGE_LABELS[stage]}`);
    fetchLeads();
  };

  const handleSnooze = async (leadId: string, days: number | null) => {
    if (!user) return;
    const paused_until = days === null
      ? null
      : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-team-member-id': user.team_member_id },
      body: JSON.stringify({ paused_until }),
    });
    if (res.ok) {
      toast.success(days === null ? 'Unsnoozed' : `Snoozed for ${days} day${days > 1 ? 's' : ''}`);
      fetchLeads();
    } else {
      toast.error('Failed to snooze');
    }
  };

  const daysSince = (date: string | null | undefined): number | null => {
    if (!date) return null;
    return differenceInDays(new Date(), new Date(date));
  };

  const daysSinceColor = (days: number | null): string => {
    if (days === null) return 'text-gray-400';
    if (days < 1) return 'text-green-600';
    if (days < 2) return 'text-yellow-600';
    return 'text-red-600';
  };

  const totalPages = Math.ceil(total / limit);

  // ── Selection helpers ──────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === leads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(leads.map((l) => l.id)));
    }
  };

  // ── Bulk actions ───────────────────────────────────────────────────
  const bulkPatch = async (body: Record<string, unknown>) => {
    if (!user) return;
    const ids = [...selectedIds];
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const res = await fetch(`/api/leads/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-team-member-id': user.team_member_id,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Failed to update lead ${id}: ${res.status}`);
      })
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - fulfilled;
    if (failed === 0) {
      toast.success(`Updated ${fulfilled} lead(s)`);
    } else if (fulfilled === 0) {
      toast.error(`Failed to update all ${failed} lead(s)`);
    } else {
      toast.warning(`${fulfilled} of ${ids.length} leads updated; ${failed} failed`);
    }
    setSelectedIds(new Set());
    fetchLeads();
  };

  // ── CSV Export ─────────────────────────────────────────────────────
  const handleExportCSV = async () => {
    if (!user) return;
    // Fetch all with current filters (no pagination)
    const params = new URLSearchParams();
    if (preset !== 'all') params.set('preset', preset);
    if (debouncedSearch) params.set('q', debouncedSearch);
    selectedStages.forEach((s) => params.append('stage', s));
    if (selectedPriority) params.set('priority', selectedPriority);
    if (selectedOwner) params.set('owned_by', selectedOwner);
    params.set('sort_by', sortBy);
    params.set('sort_dir', sortDir);
    params.set('limit', '1000');

    const res = await fetch(`/api/leads?${params}`, {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (!res.ok) {
      toast.error('Export failed');
      return;
    }
    const data = await res.json();
    const allLeads: Lead[] = data.leads || [];

    const headers = [
      'Name', 'Company', 'Email', 'Stage', 'Priority',
      'Owned By', 'First Reply At', 'Call Scheduled For',
      'Demo Sent At', 'Heat Score',
    ];

    const rows = allLeads.map((l) => [
      l.contact_name,
      l.company_name,
      l.contact_email,
      STAGE_LABELS[l.stage],
      PRIORITY_LABELS[l.priority],
      (l.owned_by_member as TeamMember | undefined)?.name || '',
      l.first_reply_at ? formatDateTime(l.first_reply_at) : '',
      l.call_scheduled_for ? formatDateTime(l.call_scheduled_for) : '',
      l.demo_sent_at ? formatDateTime(l.demo_sent_at) : '',
      String(l.heat_score),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`));

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'proxi-leads.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${allLeads.length} leads`);
  };

  return (
    <div className="space-y-4">
      {/* Preset tabs */}
      <div className="flex items-center gap-1 border-b border-gray-100 overflow-x-auto">
        {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
          <button
            key={p}
            onClick={() => {
              setPreset(p);
              setPage(1);
            }}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              preset === p
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Search + filters + export + add */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            ref={searchInputRef}
            className="pl-9"
            placeholder="Search leads... (/)"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* Stage multi-select */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground">
            Stage{' '}
            {selectedStages.length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0">
                {selectedStages.length}
              </Badge>
            )}
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {ACTIVE_STAGES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={selectedStages.includes(s)}
                onCheckedChange={(checked) => {
                  setSelectedStages((prev) =>
                    checked ? [...prev, s] : prev.filter((x) => x !== s)
                  );
                  setPage(1);
                }}
              >
                {STAGE_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Priority filter */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground">
            Priority{' '}
            {selectedPriority && (
              <span className="font-medium text-xs capitalize">{selectedPriority}</span>
            )}
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => { setSelectedPriority(''); setPage(1); }}>
              All
            </DropdownMenuItem>
            {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
              <DropdownMenuItem key={p} onClick={() => { setSelectedPriority(p); setPage(1); }}>
                <span className={cn('mr-2 h-2 w-2 rounded-full inline-block', PRIORITY_COLORS[p])} />
                {PRIORITY_LABELS[p]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Owner filter */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground">
            Owner{' '}
            {selectedOwner && (
              <span className="font-medium text-xs">
                {members.find((m) => m.id === selectedOwner)?.name}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => { setSelectedOwner(''); setPage(1); }}>
              All
            </DropdownMenuItem>
            {members.map((m) => (
              <DropdownMenuItem key={m.id} onClick={() => { setSelectedOwner(m.id); setPage(1); }}>
                {m.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCSV} className="gap-1.5 hidden sm:inline-flex">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button size="sm" onClick={() => setShowAddLead(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Add Lead</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </div>
      </div>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-900 text-white rounded-lg text-sm">
          <span className="font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-2">
            {/* Reassign */}
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs font-medium transition-colors">
                Reassign <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {members.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => bulkPatch({ owned_by: m.id })}>
                    {m.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Change Stage */}
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs font-medium transition-colors">
                Change Stage <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(Object.keys(STAGE_LABELS) as LeadStage[]).map((s) => (
                  <DropdownMenuItem key={s} onClick={() => bulkPatch({ stage: s })}>
                    {STAGE_LABELS[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Change Priority */}
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs font-medium transition-colors">
                Priority <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
                  <DropdownMenuItem key={p} onClick={() => bulkPatch({ priority: p })}>
                    <span className={cn('mr-2 h-2 w-2 rounded-full inline-block', PRIORITY_COLORS[p])} />
                    {PRIORITY_LABELS[p]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-white/60 hover:text-white"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading ? (
        <SkeletonTable cols={12} rows={5} />
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden md:block rounded-lg border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/50">
                    <th className="px-4 py-2.5 w-8">
                      <Checkbox
                        checked={leads.length > 0 && selectedIds.size === leads.length}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all"
                      />
                    </th>
                    {[
                      { key: 'contact_name', label: 'Contact' },
                      { key: 'company_name', label: 'Company' },
                      { key: 'contact_role', label: 'Role', noSort: true },
                      { key: 'stage', label: 'Stage' },
                      { key: 'priority', label: 'Priority' },
                      { key: 'owned_by', label: 'Owner', noSort: true },
                      { key: 'last_contact_at', label: 'Last Contact' },
                      { key: '_days', label: 'Days Since', noSort: true },
                      { key: 'next_followup_at', label: 'Next Follow-up' },
                      { key: 'poc_status', label: 'POC', noSort: true },
                      { key: '_snooze', label: '', noSort: true },
                    ].map((col) => (
                      <th
                        key={col.key}
                        className={cn(
                          'px-4 py-2.5 text-left font-medium text-gray-500 whitespace-nowrap',
                          !col.noSort && 'cursor-pointer hover:text-gray-700'
                        )}
                        onClick={() => !col.noSort && handleSort(col.key)}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          {!col.noSort && <SortIcon col={col.key} />}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {leads.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-16 text-center">
                        <div className="flex flex-col items-center gap-3 text-gray-400">
                          <Users className="h-10 w-10 text-gray-200" />
                          <p className="font-medium text-sm">No leads found</p>
                          <p className="text-xs">Try adjusting your filters or add your first lead.</p>
                          <Button size="sm" variant="outline" onClick={() => setShowAddLead(true)} className="mt-2 gap-1.5">
                            <Plus className="h-4 w-4" />
                            Add Lead
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    leads.map((lead) => {
                      const days = daysSince(lead.last_contact_at);
                      const isSelected = selectedIds.has(lead.id);
                      return (
                        <tr
                          key={lead.id}
                          className={cn(
                            'hover:bg-gray-50/50 cursor-pointer group',
                            isSelected && 'bg-blue-50/40'
                          )}
                          onClick={() => router.push(`/leads/${lead.id}`)}
                        >
                          <td
                            className="px-4 py-3"
                            onClick={(e) => { e.stopPropagation(); toggleSelect(lead.id); }}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(lead.id)}
                              aria-label={`Select ${lead.contact_name}`}
                            />
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                            <span className="flex items-center gap-1.5">
                              {lead.contact_name}
                              {lead.paused_until && new Date(lead.paused_until) > new Date() && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium"
                                  title={`Snoozed until ${new Date(lead.paused_until).toLocaleDateString()}`}
                                >
                                  <BellOff className="h-2.5 w-2.5" />
                                  OOO
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                            {lead.company_name}
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                            {lead.contact_role || '—'}
                          </td>
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger className="cursor-pointer">
                                <StageBadge stage={lead.stage} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-44">
                                {(Object.keys(STAGE_LABELS) as LeadStage[]).map((s) => (
                                  <DropdownMenuItem key={s} onClick={() => handleStageChange(lead.id, s)}>
                                    {STAGE_LABELS[s]}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5">
                              <span className={cn('h-2 w-2 rounded-full', PRIORITY_COLORS[lead.priority])} />
                              <span className="text-gray-600">{PRIORITY_LABELS[lead.priority]}</span>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                            {(lead.owned_by_member as TeamMember | undefined)?.name || '—'}
                          </td>
                          <td
                            className="px-4 py-3 text-gray-500 whitespace-nowrap"
                            title={lead.last_contact_at ? formatDateTime(lead.last_contact_at) : ''}
                          >
                            {lead.last_contact_at ? formatRelativeTime(lead.last_contact_at) : '—'}
                          </td>
                          <td className={cn('px-4 py-3 font-medium whitespace-nowrap', daysSinceColor(days))}>
                            {days !== null ? `${days}d` : '—'}
                          </td>
                          <td
                            className="px-4 py-3 text-gray-500 whitespace-nowrap"
                            title={lead.next_followup_at ? formatDateTime(lead.next_followup_at) : ''}
                          >
                            {lead.next_followup_at ? formatRelativeTime(lead.next_followup_at) : '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap capitalize">
                            {lead.poc_status?.replace('_', ' ') || '—'}
                          </td>
                          <td
                            className="px-4 py-3 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                className={cn(
                                  'opacity-0 group-hover:opacity-100 transition-opacity',
                                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
                                  lead.paused_until && new Date(lead.paused_until) > new Date()
                                    ? 'opacity-100 text-amber-600 bg-amber-50 border border-amber-200'
                                    : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                                )}
                                title={
                                  lead.paused_until && new Date(lead.paused_until) > new Date()
                                    ? `Snoozed until ${new Date(lead.paused_until).toLocaleDateString()}`
                                    : 'Snooze'
                                }
                              >
                                <BellOff className="h-3 w-3" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40">
                                <div className="px-2 py-1 text-xs text-gray-500 font-medium">Snooze (OOO)</div>
                                {[
                                  { label: '3 days', days: 3 },
                                  { label: '7 days', days: 7 },
                                  { label: '14 days', days: 14 },
                                  { label: '30 days', days: 30 },
                                ].map(({ label, days }) => (
                                  <DropdownMenuItem
                                    key={days}
                                    onClick={() => handleSnooze(lead.id, days)}
                                  >
                                    <Clock className="h-3 w-3 mr-1.5 text-gray-400" />
                                    {label}
                                  </DropdownMenuItem>
                                ))}
                                {lead.paused_until && new Date(lead.paused_until) > new Date() && (
                                  <DropdownMenuItem
                                    onClick={() => handleSnooze(lead.id, null)}
                                    className="text-red-600"
                                  >
                                    <X className="h-3 w-3 mr-1.5" />
                                    Unsnooze
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile Card View */}
          <div className="md:hidden space-y-2">
            {leads.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-gray-400 text-center">
                <Users className="h-10 w-10 text-gray-200" />
                <p className="font-medium text-sm">No leads found</p>
                <p className="text-xs">Try adjusting your filters or add a new lead.</p>
              </div>
            ) : (
              leads.map((lead) => (
                <div
                  key={lead.id}
                  onClick={() => router.push(`/leads/${lead.id}`)}
                  className={cn(
                    'rounded-lg border border-gray-100 bg-white p-4 cursor-pointer hover:border-gray-200 transition-colors',
                    selectedIds.has(lead.id) && 'border-blue-300 bg-blue-50/30'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{lead.contact_name}</p>
                      <p className="text-sm text-gray-500 truncate">{lead.company_name}</p>
                    </div>
                    <StageBadge stage={lead.stage} />
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_COLORS[lead.priority])} />
                      {PRIORITY_LABELS[lead.priority]}
                    </span>
                    {lead.last_contact_at && (
                      <span title={formatDateTime(lead.last_contact_at)}>
                        {formatRelativeTime(lead.last_contact_at)}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total} leads
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <LeadFormModal open={showAddLead} onClose={() => setShowAddLead(false)} onSuccess={fetchLeads} />
    </div>
  );
}

