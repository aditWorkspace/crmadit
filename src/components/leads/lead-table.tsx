'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { Lead, TeamMember, LeadStage, Priority } from '@/types';
import { StageBadge } from './stage-badge';
import { LeadFormModal } from './lead-form';
import { STAGE_LABELS, PRIORITY_COLORS, PRIORITY_LABELS, ACTIVE_STAGES } from '@/lib/constants';
import { formatRelativeTime, cn } from '@/lib/utils';
import { differenceInDays } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
} from 'lucide-react';

type Preset = 'all' | 'my_leads' | 'awaiting_response' | 'awaiting_demo' | 'stale';
type SortDir = 'asc' | 'desc';

const PRESET_LABELS: Record<Preset, string> = {
  all: 'All',
  my_leads: 'My Leads',
  awaiting_response: 'Awaiting Response',
  awaiting_demo: 'Awaiting Demo',
  stale: 'Stale',
};

export function LeadTable() {
  const { user } = useSession();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [showAddLead, setShowAddLead] = useState(false);

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

  return (
    <div className="space-y-4">
      {/* Preset tabs */}
      <div className="flex items-center gap-1 border-b border-gray-100">
        {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
          <button
            key={p}
            onClick={() => {
              setPreset(p);
              setPage(1);
            }}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              preset === p
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Search + filters + add button */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-60">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            className="pl-9"
            placeholder="Search leads..."
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
            <DropdownMenuItem
              onClick={() => {
                setSelectedPriority('');
                setPage(1);
              }}
            >
              All
            </DropdownMenuItem>
            {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
              <DropdownMenuItem
                key={p}
                onClick={() => {
                  setSelectedPriority(p);
                  setPage(1);
                }}
              >
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
            <DropdownMenuItem
              onClick={() => {
                setSelectedOwner('');
                setPage(1);
              }}
            >
              All
            </DropdownMenuItem>
            {members.map((m) => (
              <DropdownMenuItem
                key={m.id}
                onClick={() => {
                  setSelectedOwner(m.id);
                  setPage(1);
                }}
              >
                {m.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto">
          <Button size="sm" onClick={() => setShowAddLead(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Add Lead
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
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
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    No leads found. Add your first lead to get started.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => {
                  const days = daysSince(lead.last_contact_at);
                  return (
                    <tr
                      key={lead.id}
                      className="hover:bg-gray-50/50 cursor-pointer group"
                      onClick={() => router.push(`/leads/${lead.id}`)}
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        {lead.contact_name}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {lead.company_name}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {lead.contact_role || '—'}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger className="cursor-pointer">
                            <StageBadge stage={lead.stage} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-44">
                            {(Object.keys(STAGE_LABELS) as LeadStage[]).map((s) => (
                              <DropdownMenuItem
                                key={s}
                                onClick={() => handleStageChange(lead.id, s)}
                              >
                                {STAGE_LABELS[s]}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn('h-2 w-2 rounded-full', PRIORITY_COLORS[lead.priority])}
                          />
                          <span className="text-gray-600">{PRIORITY_LABELS[lead.priority]}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {(lead.owned_by_member as TeamMember | undefined)?.name || '—'}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500 whitespace-nowrap"
                        title={lead.last_contact_at || ''}
                      >
                        {lead.last_contact_at ? formatRelativeTime(lead.last_contact_at) : '—'}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-3 font-medium whitespace-nowrap',
                          daysSinceColor(days)
                        )}
                      >
                        {days !== null ? `${days}d` : '—'}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500 whitespace-nowrap"
                        title={lead.next_followup_at || ''}
                      >
                        {lead.next_followup_at ? formatRelativeTime(lead.next_followup_at) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap capitalize">
                        {lead.poc_status?.replace('_', ' ') || '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
