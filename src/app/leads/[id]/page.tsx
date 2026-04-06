'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Lead, ActionItem, Interaction, ActivityLog, TeamMember, LeadStage, Transcript } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { STAGE_LABELS, PRIORITY_COLORS, PRIORITY_LABELS } from '@/lib/constants';
import { StageBadge } from '@/components/leads/stage-badge';
import { LeadSteps } from '@/components/leads/lead-steps';
import { LeadTimeline } from '@/components/leads/lead-timeline';
import { LeadInfoPanel } from '@/components/leads/lead-info-panel';
import { ActionItemList } from '@/components/action-items/action-item-list';
import { InlineEdit } from '@/components/leads/inline-edit';
import { TranscriptUploadModal } from '@/components/transcripts/upload-modal';
import { AiInsights } from '@/components/transcripts/ai-insights';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ArrowLeft, Flame, Upload } from 'lucide-react';
import Link from 'next/link';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useSession();
  const router = useRouter();

  const [lead, setLead] = useState<Lead | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [loading, setLoading] = useState(true);

  const getHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(user ? { 'x-team-member-id': user.team_member_id } : {}),
  });

  useEffect(() => {
    if (!user) return;
    const headers: Record<string, string> = { 'x-team-member-id': user.team_member_id, 'Content-Type': 'application/json' };
    (async () => {
      try {
        const supabase = createClient();
        const [leadRes, aiRes, intRes, actRes, memRes, transcriptRes] = await Promise.all([
          fetch(`/api/leads/${id}`, { headers }).then(r => r.json()),
          fetch(`/api/leads/${id}/action-items`, { headers }).then(r => r.json()),
          fetch(`/api/leads/${id}/interactions`, { headers }).then(r => r.json()),
          supabase
            .from('activity_log')
            .select('*, team_member:team_members(id, name)')
            .eq('lead_id', id)
            .order('created_at', { ascending: false })
            .limit(50),
          supabase
            .from('team_members')
            .select('id, name, email, gmail_connected, created_at'),
          supabase
            .from('transcripts')
            .select('*')
            .eq('lead_id', id)
            .order('created_at', { ascending: false })
            .limit(1),
        ]);
        if (leadRes.lead) setLead(leadRes.lead);
        if (aiRes.action_items) setActionItems(aiRes.action_items);
        if (intRes.interactions) setInteractions(intRes.interactions);
        if (actRes.data) setActivities(actRes.data as ActivityLog[]);
        if (memRes.data) setMembers(memRes.data as TeamMember[]);
        if (transcriptRes.data?.[0]) setTranscript(transcriptRes.data[0] as Transcript);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, user]);

  const updateLead = async (updates: Partial<Lead>) => {
    if (!user || !lead) return;
    const prev = lead;
    setLead(cur => cur ? { ...cur, ...updates } : cur);
    const res = await fetch(`/api/leads/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      setLead(prev);
      toast.error('Failed to update lead');
    }
  };

  const handleStageChange = async (stage: LeadStage) => {
    if (!user) return;
    const res = await fetch(`/api/leads/${id}/stage`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ stage }),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Failed to change stage'); return; }
    toast.success(`Stage → ${STAGE_LABELS[stage]}`);
    setLead(cur => cur ? { ...cur, stage } : cur);
  };

  const handleAddNote = async () => {
    if (!noteText.trim() || !user) return;
    setAddingNote(true);
    const res = await fetch(`/api/leads/${id}/note`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ body: noteText }),
    });
    const data = await res.json();
    if (res.ok) {
      setInteractions(prev => [data.interaction, ...prev]);
      setNoteText('');
      toast.success('Note added');
    } else {
      toast.error('Failed to add note');
    }
    setAddingNote(false);
  };

  const handleAddActionItem = async (text: string) => {
    if (!user) return;
    const res = await fetch(`/api/leads/${id}/action-items`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (res.ok) setActionItems(prev => [...prev, data.action_item]);
    else toast.error('Failed to add action item');
  };

  const handleUpdateActionItem = async (itemId: string, updates: Partial<ActionItem>) => {
    if (!user) return;
    const res = await fetch(`/api/action-items/${itemId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (res.ok) setActionItems(prev => prev.map(i => i.id === itemId ? data.action_item : i));
    else toast.error('Failed to update action item');
  };

  const handleDeleteActionItem = async (itemId: string) => {
    if (!user) return;
    setActionItems(prev => prev.filter(i => i.id !== itemId));
    const res = await fetch(`/api/action-items/${itemId}`, { method: 'DELETE', headers: getHeaders() });
    if (!res.ok) {
      toast.error('Failed to delete action item');
      const r = await fetch(`/api/leads/${id}/action-items`, { headers: getHeaders() }).then(r => r.json());
      if (r.action_items) setActionItems(r.action_items);
    }
  };

  if (loading || !lead) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        {loading ? 'Loading...' : 'Lead not found'}
      </div>
    );
  }

  const heatColor =
    lead.heat_score >= 70 ? 'text-red-500' :
    lead.heat_score >= 40 ? 'text-orange-400' :
    'text-gray-300';

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="border-b border-gray-100 px-8 py-4 bg-white flex-shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <Link href="/leads" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-500">Leads</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-baseline gap-3 flex-wrap min-w-0">
            <h1 className="text-2xl font-semibold text-gray-900">
              <InlineEdit
                value={lead.contact_name}
                onSave={v => updateLead({ contact_name: v })}
                displayClassName="text-2xl font-semibold"
              />
            </h1>
            <span className="text-gray-400">·</span>
            <span className="text-lg text-gray-600">
              <InlineEdit
                value={lead.company_name}
                onSave={v => updateLead({ company_name: v })}
                displayClassName="text-lg text-gray-600"
              />
            </span>
            <span className="text-gray-400">·</span>
            <span className="text-gray-500">
              <InlineEdit
                value={lead.contact_role || ''}
                onSave={v => updateLead({ contact_role: v })}
                emptyText="Add role"
                displayClassName="text-gray-500"
              />
            </span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <Flame className={cn('h-5 w-5', heatColor)} aria-label={`Heat score: ${lead.heat_score}`} />

            {/* Priority dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
                    <span className={cn('h-2.5 w-2.5 rounded-full', PRIORITY_COLORS[lead.priority])} />
                    {PRIORITY_LABELS[lead.priority]}
                  </button>
                }
              />
              <DropdownMenuContent align="end">
                {(['critical', 'high', 'medium', 'low'] as const).map(p => (
                  <DropdownMenuItem key={p} onClick={() => updateLead({ priority: p })}>
                    <span className={cn('mr-2 h-2 w-2 rounded-full inline-block', PRIORITY_COLORS[p])} />
                    {PRIORITY_LABELS[p]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Stage dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button><StageBadge stage={lead.stage} /></button>} />
              <DropdownMenuContent align="end">
                {(Object.keys(STAGE_LABELS) as LeadStage[]).map(s => (
                  <DropdownMenuItem key={s} onClick={() => handleStageChange(s)}>
                    {STAGE_LABELS[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column (65%) */}
        <div className="flex-[65] overflow-auto border-r border-gray-100 p-6 space-y-6">
          <LeadSteps
            lead={lead}
            onStageChange={handleStageChange}
            onDateChange={(field, value) => updateLead({ [field]: new Date(value).toISOString() })}
          />

          {/* Timeline */}
          <div className="rounded-lg border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50/50 border-b border-gray-100">
              <h3 className="text-sm font-medium text-gray-700">Timeline</h3>
            </div>
            <div className="px-4">
              <LeadTimeline interactions={interactions} activities={activities} />
            </div>

            {/* Add Note */}
            <div className="border-t border-gray-100 p-4">
              <div className="flex gap-3">
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddNote(); }
                  }}
                  placeholder="Add a note... (Enter to save, Shift+Enter for new line)"
                  rows={2}
                  className="flex-1 text-sm resize-none rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
                <button
                  onClick={handleAddNote}
                  disabled={addingNote || !noteText.trim()}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40 self-end"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right column (35%) */}
        <div className="flex-[35] overflow-auto p-6 space-y-6">
          <LeadInfoPanel lead={lead} members={members} onUpdate={updateLead} />

          {/* Action Items */}
          <div>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Action Items</h4>
            <ActionItemList
              leadId={id}
              items={actionItems}
              members={members}
              memberId={user?.team_member_id || ''}
              onAdd={handleAddActionItem}
              onUpdate={handleUpdateActionItem}
              onDelete={handleDeleteActionItem}
            />
          </div>

          {/* Call notes */}
          <div>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Call Notes</h4>
            <InlineEdit
              value={lead.call_notes || ''}
              onSave={v => updateLead({ call_notes: v })}
              multiline
              emptyText="Click to add call notes..."
              displayClassName="text-sm text-gray-600"
              className="block w-full"
            />
          </div>

          {lead.next_steps && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Next Steps</h4>
              <p className="text-sm text-gray-600">{lead.next_steps}</p>
            </div>
          )}

          {/* Transcript */}
          <div>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Transcript</h4>
            {transcript ? (
              <div className="space-y-3">
                {transcript.ai_summary && (
                  <p className="text-sm text-gray-600">{transcript.ai_summary}</p>
                )}
                {transcript.processing_status === 'completed' && (
                  <AiInsights transcript={transcript} />
                )}
              </div>
            ) : (
              <button
                onClick={() => setShowUploadModal(true)}
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
              >
                <Upload className="h-4 w-4" />
                Upload Transcript
              </button>
            )}
            {transcript && (
              <button
                onClick={() => setShowUploadModal(true)}
                className="mt-2 text-xs text-gray-400 hover:text-gray-600"
              >
                + Upload new transcript
              </button>
            )}
          </div>
        </div>
      </div>

      <TranscriptUploadModal
        open={showUploadModal}
        leadId={id}
        onClose={() => setShowUploadModal(false)}
        onSuccess={() => {
          setShowUploadModal(false);
          createClient()
            .from('transcripts')
            .select('*')
            .eq('lead_id', id)
            .order('created_at', { ascending: false })
            .limit(1)
            .then(({ data }) => { if (data?.[0]) setTranscript(data[0] as Transcript); });
        }}
        members={members}
      />
    </div>
  );
}
