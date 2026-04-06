'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { Lead, Interaction, ActionItem, ActivityLog, TeamMember, LeadStage } from '@/types';
import { STAGE_LABELS, ACTIVE_STAGES, PRIORITY_COLORS, PRIORITY_LABELS } from '@/lib/constants';
import { cn, stripHtml, formatDate } from '@/lib/utils';
import { LeadTimeline } from '@/components/leads/lead-timeline';
import { ActionItemList } from '@/components/action-items/action-item-list';
import { InlineEdit } from '@/components/leads/inline-edit';
import { ComposeBar } from './compose-bar';
import { toast } from 'sonner';
import {
  X, ChevronRight, Flame, ExternalLink, Mail, Link2,
  SlidersHorizontal, Sparkles, Loader2, Trash2,
} from 'lucide-react';
import Link from 'next/link';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/* ── Compact horizontal stage bar ───────────────────────────────────── */
function StageBar({ lead, onStageChange }: { lead: Lead; onStageChange: (s: LeadStage) => void }) {
  type DisplayStage = Exclude<LeadStage, 'post_call'>;
  const displayStages = ACTIVE_STAGES.filter((s): s is DisplayStage => s !== 'post_call');
  const currentIdx = displayStages.indexOf(lead.stage as DisplayStage);

  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1 scrollbar-none">
      {displayStages.map((stage, idx) => {
        const done = idx < currentIdx;
        const active = idx === currentIdx;
        const future = idx > currentIdx;
        return (
          <div key={stage} className="flex items-center flex-shrink-0">
            <button
              onClick={() => future && onStageChange(stage)}
              disabled={done || active}
              title={STAGE_LABELS[stage]}
              className={cn(
                'flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors',
                done && 'text-gray-400',
                active && 'text-blue-700 font-semibold bg-blue-50 rounded',
                future && 'text-gray-400 hover:text-gray-600 cursor-pointer hover:bg-gray-100 rounded'
              )}
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full flex-shrink-0',
                done && 'bg-gray-300',
                active && 'bg-blue-500',
                future && 'bg-gray-200'
              )} />
              {STAGE_LABELS[stage]}
            </button>
            {idx < displayStages.length - 1 && (
              <ChevronRight className="h-3 w-3 text-gray-200 flex-shrink-0" />
            )}
          </div>
        );
      })}

      {/* Paused / Dead shown separately */}
      {(lead.stage === 'paused' || lead.stage === 'dead' || lead.stage === 'post_call') && (
        <span className="ml-3 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">
          {STAGE_LABELS[lead.stage]}
        </span>
      )}
    </div>
  );
}

/* ── Info drawer ─────────────────────────────────────────────────────── */
function InfoDrawer({ lead, members, actionItems, onUpdate, onAddItem, onUpdateItem, onDeleteItem, memberId }:{
  lead: Lead;
  members: TeamMember[];
  actionItems: ActionItem[];
  memberId: string;
  onUpdate: (u: Partial<Lead>) => Promise<void>;
  onAddItem: (text: string) => Promise<void>;
  onUpdateItem: (id: string, u: Partial<ActionItem>) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      {/* Contact */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Contact</p>
        <div className="space-y-1.5">
          {lead.contact_email && (
            <a href={`mailto:${lead.contact_email}`} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 truncate">
              <Mail className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              {lead.contact_email}
            </a>
          )}
          {lead.contact_linkedin && (
            <a href={lead.contact_linkedin} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-gray-600 hover:text-gray-900">
              <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              LinkedIn
            </a>
          )}
        </div>
      </div>

      {/* Company */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Company</p>
        <div className="space-y-1 text-gray-600">
          {lead.company_url && (
            <a href={lead.company_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-gray-900 truncate">
              <ExternalLink className="h-3 w-3 flex-shrink-0 text-gray-400" />
              {lead.company_url.replace(/^https?:\/\//, '')}
            </a>
          )}
          {lead.company_stage && <p className="text-xs text-gray-500">{lead.company_stage}</p>}
          {lead.company_size && <p className="text-xs text-gray-500">{lead.company_size} employees</p>}
        </div>
      </div>

      {/* Ownership */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Owned by</p>
        <DropdownMenu>
          <DropdownMenuTrigger render={
            <button className="text-sm text-gray-700 hover:text-gray-900 flex items-center gap-1">
              {members.find(m => m.id === lead.owned_by)?.name || '—'}
              <ChevronRight className="h-3 w-3 rotate-90 text-gray-400" />
            </button>
          } />
          <DropdownMenuContent>
            {members.map(m => (
              <DropdownMenuItem key={m.id} onClick={() => onUpdate({ owned_by: m.id })}>
                {m.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Call notes */}
      {(lead.stage === 'call_completed' || lead.stage === 'demo_sent' || lead.stage === 'feedback_call' || lead.stage === 'active_user') && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Call Notes</p>
          <InlineEdit
            value={lead.call_notes || ''}
            onSave={v => onUpdate({ call_notes: v })}
            multiline
            emptyText="Add call notes..."
            displayClassName="text-sm text-gray-600"
          />
        </div>
      )}

      {/* Next steps */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Next Steps</p>
        <InlineEdit
          value={lead.next_steps || ''}
          onSave={v => onUpdate({ next_steps: v })}
          multiline
          emptyText="Add next steps..."
          displayClassName="text-sm text-gray-600"
        />
      </div>

      {/* Action Items */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Action Items</p>
        <ActionItemList
          leadId={lead.id}
          items={actionItems}
          members={members}
          memberId={memberId}
          onAdd={onAddItem}
          onUpdate={onUpdateItem}
          onDelete={onDeleteItem}
        />
      </div>
    </div>
  );
}

/* ── Main LeadPanel ──────────────────────────────────────────────────── */
interface LeadPanelProps {
  leadId: string;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export function LeadPanel({ leadId, onClose, onDelete }: LeadPanelProps) {
  const { user } = useSession();
  const [lead, setLead] = useState<Lead | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [suggestingAction, setSuggestingAction] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const headers = useCallback((): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(user ? { 'x-team-member-id': user.team_member_id } : {}),
  }), [user]);

  // Fetch all data when leadId changes
  useEffect(() => {
    if (!user || !leadId) return;
    setLoading(true);
    setLead(null);
    setInteractions([]);
    setActivities([]);
    setActionItems([]);

    const h = { 'x-team-member-id': user.team_member_id, 'Content-Type': 'application/json' };
    const supabase = createClient();

    Promise.all([
      fetch(`/api/leads/${leadId}`, { headers: h }).then(r => r.json()),
      fetch(`/api/leads/${leadId}/interactions`, { headers: h }).then(r => r.json()),
      fetch(`/api/leads/${leadId}/action-items`, { headers: h }).then(r => r.json()),
      supabase.from('activity_log').select('*, team_member:team_members(id, name)').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30),
      supabase.from('team_members').select('id, name, email, gmail_connected, created_at'),
    ]).then(([leadRes, intRes, aiRes, actRes, memRes]) => {
      if (leadRes.lead) setLead(leadRes.lead);
      if (intRes.interactions) setInteractions(intRes.interactions);
      if (aiRes.action_items) setActionItems(aiRes.action_items);
      if (actRes.data) setActivities(actRes.data as ActivityLog[]);
      if (memRes.data) setMembers(memRes.data as TeamMember[]);
    }).finally(() => setLoading(false));
  }, [leadId, user]);

  // Scroll to bottom of thread when loaded
  useEffect(() => {
    if (!loading && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [loading]);

  const updateLead = async (updates: Partial<Lead>) => {
    if (!user || !lead) return;
    const prev = lead;
    setLead(cur => cur ? { ...cur, ...updates } : cur);
    const res = await fetch(`/api/leads/${leadId}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(updates) });
    if (!res.ok) { setLead(prev); toast.error('Failed to update'); }
  };

  const handleStageChange = async (stage: LeadStage) => {
    if (!user) return;
    const res = await fetch(`/api/leads/${leadId}/stage`, { method: 'POST', headers: headers(), body: JSON.stringify({ stage }) });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Stage change failed'); return; }
    toast.success(`→ ${STAGE_LABELS[stage]}`);
    setLead(cur => cur ? { ...cur, stage } : cur);
  };

  const handleSuggestAction = async () => {
    if (!user) return;
    setSuggestingAction(true);
    const res = await fetch(`/api/leads/${leadId}/suggest-action`, { method: 'POST', headers: headers() });
    const data = await res.json();
    if (res.ok) setLead(cur => cur ? { ...cur, ...data } : cur);
    else toast.error(data.error || 'AI scoring failed');
    setSuggestingAction(false);
  };

  const handleDeleteLead = async () => {
    if (!user || !lead) return;
    if (!confirm(`Delete ${lead.contact_name}? This cannot be undone.`)) return;
    setDeleting(true);
    const res = await fetch(`/api/leads/${leadId}`, { method: 'DELETE', headers: headers() });
    if (res.ok) { toast.success('Lead deleted'); onDelete(leadId); }
    else { toast.error('Failed to delete'); setDeleting(false); }
  };

  const handleAddNote = async (body: string) => {
    if (!user || !body.trim()) return;
    const res = await fetch(`/api/leads/${leadId}/note`, { method: 'POST', headers: headers(), body: JSON.stringify({ body }) });
    const data = await res.json();
    if (res.ok) setInteractions(prev => [...prev, data.interaction]);
    else toast.error('Failed to add note');
  };

  const latestThread = interactions.slice().reverse().find(i => i.gmail_thread_id);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Lead not found.
      </div>
    );
  }

  const heatColor = lead.heat_score >= 70 ? 'text-red-500' : lead.heat_score >= 40 ? 'text-orange-400' : 'text-gray-300';

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main panel */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* ── Header ── */}
        <div className="flex-shrink-0 border-b border-gray-100 px-5 py-3 bg-white">
          {/* Row 1: name + actions */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-gray-900">
                  <InlineEdit value={lead.contact_name} onSave={v => updateLead({ contact_name: v })} displayClassName="text-base font-semibold" />
                </h2>
                <span className="text-gray-300 text-sm">·</span>
                <span className="text-sm text-gray-500">
                  <InlineEdit value={lead.company_name} onSave={v => updateLead({ company_name: v })} displayClassName="text-sm text-gray-600" />
                </span>
                {lead.contact_role && (
                  <>
                    <span className="text-gray-300 text-sm">·</span>
                    <span className="text-sm text-gray-400">
                      <InlineEdit value={lead.contact_role} onSave={v => updateLead({ contact_role: v })} displayClassName="text-sm text-gray-400" />
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Flame className={cn('h-4 w-4', heatColor)} aria-label={`Heat: ${lead.heat_score}`} />

              {/* Priority */}
              <DropdownMenu>
                <DropdownMenuTrigger render={
                  <button className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                    <span className={cn('h-2 w-2 rounded-full', PRIORITY_COLORS[lead.priority])} />
                    {PRIORITY_LABELS[lead.priority]}
                  </button>
                } />
                <DropdownMenuContent align="end">
                  {(['critical', 'high', 'medium', 'low'] as const).map(p => (
                    <DropdownMenuItem key={p} onClick={() => updateLead({ priority: p })}>
                      <span className={cn('mr-2 h-2 w-2 rounded-full inline-block', PRIORITY_COLORS[p])} />
                      {PRIORITY_LABELS[p]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* AI action */}
              <button onClick={handleSuggestAction} disabled={suggestingAction} title="AI suggested action" className="text-gray-300 hover:text-amber-500 transition-colors disabled:opacity-40">
                {suggestingAction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </button>

              {/* Info drawer toggle */}
              <button
                onClick={() => setShowInfo(v => !v)}
                className={cn('text-gray-400 hover:text-gray-700 transition-colors', showInfo && 'text-blue-500')}
                title="Show info & actions"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>

              {/* Full page link */}
              <Link href={`/leads/${leadId}`} className="text-gray-300 hover:text-gray-600 transition-colors" title="Open full page">
                <ExternalLink className="h-4 w-4" />
              </Link>

              {/* Delete */}
              <button onClick={handleDeleteLead} disabled={deleting} className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40" title="Delete lead">
                <Trash2 className="h-4 w-4" />
              </button>

              {/* Close */}
              <button onClick={onClose} className="text-gray-300 hover:text-gray-600 transition-colors" title="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Row 2: stage bar */}
          <StageBar lead={lead} onStageChange={handleStageChange} />

          {/* Row 3: AI next action (if present) */}
          {lead.ai_next_action && (
            <div className="flex items-start gap-1.5 mt-2 px-2 py-1.5 bg-amber-50 rounded-lg">
              <Sparkles className="h-3 w-3 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{lead.ai_next_action}</p>
            </div>
          )}
        </div>

        {/* ── Thread (scrollable) ── */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4">
          {interactions.length === 0 && activities.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              No activity yet. Sync Gmail or add a note to start the timeline.
            </div>
          ) : (
            <LeadTimeline
              interactions={interactions}
              activities={activities}
              onReply={ctx => {
                // ComposeBar handles replies — just surface the thread context
                const el = document.getElementById('compose-textarea');
                if (el) el.focus();
              }}
            />
          )}

          {/* Quick note input */}
          <NoteInput onAdd={handleAddNote} />
        </div>

        {/* ── Compose bar (pinned) ── */}
        {user && (
          <ComposeBar
            leadId={leadId}
            toEmail={lead.contact_email}
            threadId={latestThread?.gmail_thread_id ?? null}
            teamMemberId={user.team_member_id}
            aiSuggestion={lead.ai_next_action}
            onSent={(interaction) => {
              if (interaction) setInteractions(prev => [...prev, interaction as Interaction]);
            }}
          />
        )}
      </div>

      {/* ── Info drawer (slides in from right) ── */}
      {showInfo && (
        <div className="w-72 flex-shrink-0 border-l border-gray-100 overflow-y-auto bg-gray-50/30">
          <InfoDrawer
            lead={lead}
            members={members}
            actionItems={actionItems}
            memberId={user?.team_member_id || ''}
            onUpdate={updateLead}
            onAddItem={async (text) => {
              if (!user) return;
              const res = await fetch(`/api/leads/${leadId}/action-items`, { method: 'POST', headers: headers(), body: JSON.stringify({ text }) });
              const data = await res.json();
              if (res.ok) setActionItems(prev => [...prev, data.action_item]);
            }}
            onUpdateItem={async (id, updates) => {
              const res = await fetch(`/api/action-items/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(updates) });
              const data = await res.json();
              if (res.ok) setActionItems(prev => prev.map(i => i.id === id ? data.action_item : i));
            }}
            onDeleteItem={async (id) => {
              setActionItems(prev => prev.filter(i => i.id !== id));
              await fetch(`/api/action-items/${id}`, { method: 'DELETE', headers: headers() });
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ── Quick note input (in thread area) ───────────────────────────────── */
function NoteInput({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = async () => {
    if (!text.trim()) return;
    setAdding(true);
    await onAdd(text);
    setText('');
    setAdding(false);
  };

  return (
    <div className="mt-4 flex gap-2">
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder="Add a note..."
        className="flex-1 text-sm rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 bg-white"
      />
      <button
        onClick={submit}
        disabled={adding || !text.trim()}
        className="px-3 py-2 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg disabled:opacity-40 transition-colors"
      >
        Note
      </button>
    </div>
  );
}
