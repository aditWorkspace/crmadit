'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import { Lead, Interaction, ActionItem, ActivityLog, TeamMember, LeadStage, Transcript } from '@/types';
import { STAGE_LABELS, ACTIVE_STAGES, PRIORITY_COLORS, PRIORITY_LABELS } from '@/lib/constants';
import { cn, formatDate } from '@/lib/utils';
import { LeadTimeline } from '@/components/leads/lead-timeline';
import { ActionItemList } from '@/components/action-items/action-item-list';
import { InlineEdit } from '@/components/leads/inline-edit';
import { ComposeBar } from './compose-bar';
import { toast } from 'sonner';
import {
  X, ChevronRight, Flame, ExternalLink, Mail, Link2,
  Sparkles, Loader2, Trash2, FileText, Upload, ChevronDown,
  ChevronUp, AlertCircle, CheckCircle2, Clock, Tag,
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

      {(lead.stage === 'paused' || lead.stage === 'dead' || lead.stage === 'post_call') && (
        <span className="ml-3 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">
          {STAGE_LABELS[lead.stage]}
        </span>
      )}
    </div>
  );
}

/* ── Transcript card ─────────────────────────────────────────────────── */
function TranscriptCard({ transcript }: { transcript: Transcript }) {
  const [expanded, setExpanded] = useState(false);

  const sentimentColor = transcript.ai_sentiment === 'positive'
    ? 'text-emerald-600 bg-emerald-50'
    : transcript.ai_sentiment === 'negative'
      ? 'text-red-600 bg-red-50'
      : 'text-gray-600 bg-gray-100';

  const interestColor = transcript.ai_interest_level === 'high'
    ? 'text-blue-700 bg-blue-50'
    : transcript.ai_interest_level === 'low'
      ? 'text-gray-500 bg-gray-100'
      : 'text-amber-700 bg-amber-50';

  return (
    <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-xs font-medium text-gray-600">
            {formatDate(transcript.created_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {transcript.processing_status === 'completed' && (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          )}
          {transcript.processing_status === 'processing' && (
            <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
          )}
          {transcript.processing_status === 'failed' && (
            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
          )}
          {transcript.processing_status === 'pending' && (
            <Clock className="h-3.5 w-3.5 text-gray-400" />
          )}
          <button onClick={() => setExpanded(v => !v)} className="text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* AI summary (always visible if completed) */}
      {transcript.processing_status === 'completed' && transcript.ai_summary && (
        <div className="px-3 py-2.5">
          <p className="text-xs text-gray-700 leading-relaxed">{transcript.ai_summary}</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {transcript.ai_sentiment && (
              <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize', sentimentColor)}>
                {transcript.ai_sentiment}
              </span>
            )}
            {transcript.ai_interest_level && (
              <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize', interestColor)}>
                {transcript.ai_interest_level} interest
              </span>
            )}
          </div>
        </div>
      )}

      {/* Expanded details */}
      {expanded && transcript.processing_status === 'completed' && (
        <div className="border-t border-gray-100 px-3 py-2.5 space-y-3">
          {/* Next steps */}
          {transcript.ai_next_steps && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Next Steps</p>
              <p className="text-xs text-gray-600 whitespace-pre-wrap">{transcript.ai_next_steps}</p>
            </div>
          )}

          {/* Pain points */}
          {transcript.ai_pain_points && transcript.ai_pain_points.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Pain Points</p>
              <ul className="space-y-0.5">
                {transcript.ai_pain_points.map((p, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className={cn(
                      'text-[10px] font-medium px-1 py-0.5 rounded mt-0.5 flex-shrink-0',
                      p.severity === 'high' ? 'bg-red-50 text-red-600' :
                        p.severity === 'medium' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'
                    )}>{p.severity}</span>
                    <span className="text-xs text-gray-600">{p.pain_point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Key quotes */}
          {transcript.ai_key_quotes && transcript.ai_key_quotes.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Key Quotes</p>
              <div className="space-y-1">
                {transcript.ai_key_quotes.slice(0, 2).map((q, i) => (
                  <blockquote key={i} className="border-l-2 border-gray-200 pl-2">
                    <p className="text-xs text-gray-600 italic">&ldquo;{q.quote}&rdquo;</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">— {q.speaker}</p>
                  </blockquote>
                ))}
              </div>
            </div>
          )}

          {/* Action items */}
          {transcript.ai_action_items && transcript.ai_action_items.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Action Items</p>
              <ul className="space-y-0.5">
                {transcript.ai_action_items.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className={cn(
                      'text-[10px] font-medium px-1 py-0.5 rounded mt-0.5 flex-shrink-0',
                      a.urgency === 'high' ? 'bg-red-50 text-red-600' :
                        a.urgency === 'medium' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'
                    )}>{a.urgency}</span>
                    <span className="text-xs text-gray-600">{a.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {transcript.processing_status === 'processing' && (
        <div className="px-3 py-3 flex items-center gap-2 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
          AI is analyzing this transcript…
        </div>
      )}

      {transcript.processing_status === 'failed' && (
        <div className="px-3 py-2.5 text-xs text-red-500">
          Processing failed. Please try re-uploading.
        </div>
      )}
    </div>
  );
}

/* ── Transcript upload section ───────────────────────────────────────── */
function TranscriptUpload({
  leadId,
  headers,
  onUploaded,
}: {
  leadId: string;
  headers: Record<string, string>;
  onUploaded: (t: Transcript) => void;
}) {
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (rawText: string, file?: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('lead_id', leadId);
      fd.append('source_type', file ? 'txt_upload' : 'paste');
      if (file) fd.append('file', file);
      else fd.append('raw_text', rawText);

      // Strip Content-Type header for FormData (browser sets multipart boundary automatically)
      const { 'Content-Type': _ct, ...formHeaders } = headers;
      const res = await fetch('/api/transcripts/upload', { method: 'POST', headers: formHeaders, body: fd });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Upload failed'); return; }

      const transcript: Transcript = data.transcript;
      onUploaded(transcript);
      setText('');
      setOpen(false);
      toast.success('Transcript uploaded — processing…');

      // Trigger AI processing (fire-and-forget, component re-renders when done)
      fetch(`/api/transcripts/${transcript.id}/process`, { method: 'POST', headers })
        .then(r => r.json())
        .then(result => {
          if (result.transcript) onUploaded(result.transcript as Transcript);
        })
        .catch(() => { /* silent — transcript card shows 'failed' status */ });
    } finally {
      setUploading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 text-xs text-gray-400 hover:text-gray-700 border border-dashed border-gray-200 hover:border-gray-300 rounded-xl py-3 transition-colors"
      >
        <Upload className="h-3.5 w-3.5" />
        Upload transcript
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
      {/* Mode selector */}
      <div className="flex border-b border-gray-100">
        {(['paste', 'file'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'flex-1 text-xs py-2 font-medium transition-colors',
              mode === m ? 'bg-gray-50 text-gray-800 border-b-2 border-gray-800' : 'text-gray-400 hover:text-gray-600'
            )}
          >
            {m === 'paste' ? 'Paste text' : 'Upload .txt'}
          </button>
        ))}
      </div>

      <div className="p-3">
        {mode === 'paste' ? (
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste your call transcript here…"
            className="w-full text-xs text-gray-700 placeholder-gray-300 resize-none outline-none h-28 leading-relaxed"
          />
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-2 h-20 cursor-pointer text-gray-400 hover:text-gray-600"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            <span className="text-xs">Click to select .txt file</span>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) submit('', file);
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-between mt-2">
          <button
            onClick={() => setOpen(false)}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
          {mode === 'paste' && (
            <button
              onClick={() => text.trim() && submit(text)}
              disabled={!text.trim() || uploading}
              className="flex items-center gap-1.5 text-xs bg-gray-900 text-white px-3 py-1.5 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {uploading ? 'Processing…' : 'Analyze'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Right sidebar ───────────────────────────────────────────────────── */
function ProfileSidebar({
  lead,
  members,
  actionItems,
  transcripts,
  memberId,
  headers,
  onUpdate,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onTranscriptUploaded,
}: {
  lead: Lead;
  members: TeamMember[];
  actionItems: ActionItem[];
  transcripts: Transcript[];
  memberId: string;
  headers: Record<string, string>;
  onUpdate: (u: Partial<Lead>) => Promise<void>;
  onAddItem: (text: string) => Promise<void>;
  onUpdateItem: (id: string, u: Partial<ActionItem>) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
  onTranscriptUploaded: (t: Transcript) => void;
}) {
  return (
    <div className="h-full overflow-y-auto bg-gray-50/40 border-l border-gray-100">
      <div className="p-4 space-y-5 text-sm">

        {/* ── Pinned note ── */}
        {lead.pinned_note && (
          <div className="rounded-xl bg-amber-50 border border-amber-100 px-3 py-2.5">
            <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider mb-1">Pinned</p>
            <p className="text-xs text-amber-800">{lead.pinned_note}</p>
          </div>
        )}

        {/* ── Contact ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Contact</p>
          <div className="space-y-1.5">
            {lead.contact_email && (
              <a href={`mailto:${lead.contact_email}`} className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-900 truncate">
                <Mail className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                {lead.contact_email}
              </a>
            )}
            {lead.contact_linkedin && (
              <a href={lead.contact_linkedin} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-blue-500 hover:text-blue-700">
                <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                LinkedIn
              </a>
            )}
            {!lead.contact_email && !lead.contact_linkedin && (
              <p className="text-xs text-gray-300 italic">No contact info</p>
            )}
          </div>
        </div>

        {/* ── Company ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Company</p>
          <div className="space-y-1.5">
            {lead.company_url && (
              <a href={lead.company_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-900 truncate">
                <ExternalLink className="h-3 w-3 flex-shrink-0 text-gray-300" />
                {lead.company_url.replace(/^https?:\/\//, '')}
              </a>
            )}
            <div className="flex flex-wrap gap-2">
              {lead.company_stage && (
                <span className="text-[11px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{lead.company_stage}</span>
              )}
              {lead.company_size && (
                <span className="text-[11px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{lead.company_size} emp.</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Owned by ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Owner</p>
          <DropdownMenu>
            <DropdownMenuTrigger render={
              <button className="text-xs text-gray-700 hover:text-gray-900 flex items-center gap-1">
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

        {/* ── Priority ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Priority</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['critical', 'high', 'medium', 'low'] as const).map(p => (
              <button
                key={p}
                onClick={() => onUpdate({ priority: p })}
                className={cn(
                  'flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                  lead.priority === p
                    ? 'border-gray-400 bg-gray-100 text-gray-800 font-semibold'
                    : 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600'
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_COLORS[p])} />
                {PRIORITY_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tags ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Tags</p>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {lead.tags.map(tag => (
              <span key={tag} className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
                <Tag className="h-2.5 w-2.5" />
                {tag}
                <button
                  onClick={() => onUpdate({ tags: lead.tags.filter(t => t !== tag) })}
                  className="hover:text-red-500 ml-0.5 transition-colors"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <TagInput onAdd={tag => onUpdate({ tags: [...lead.tags, tag] })} existingTags={lead.tags} />
        </div>

        {/* ── Call notes ── */}
        {(['call_completed', 'post_call', 'demo_sent', 'feedback_call', 'active_user'] as LeadStage[]).includes(lead.stage) && (
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Call Notes</p>
            <InlineEdit
              value={lead.call_notes || ''}
              onSave={v => onUpdate({ call_notes: v })}
              multiline
              emptyText="Add call notes…"
              displayClassName="text-xs text-gray-600 leading-relaxed"
            />
          </div>
        )}

        {/* ── Next steps ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Next Steps</p>
          <InlineEdit
            value={lead.next_steps || ''}
            onSave={v => onUpdate({ next_steps: v })}
            multiline
            emptyText="Add next steps…"
            displayClassName="text-xs text-gray-600 leading-relaxed"
          />
        </div>

        {/* ── Action items ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Action Items</p>
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

        {/* ── Transcripts ── */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Transcripts</p>
          <div className="space-y-2">
            {transcripts.map(t => (
              <TranscriptCard key={t.id} transcript={t} />
            ))}
            <TranscriptUpload
              leadId={lead.id}
              headers={headers}
              onUploaded={onTranscriptUploaded}
            />
          </div>
        </div>

        {/* ── Call scheduled ── */}
        {lead.call_scheduled_for && (
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Call scheduled</p>
            <p className="text-xs text-gray-600">{formatDate(lead.call_scheduled_for)}</p>
          </div>
        )}

      </div>
    </div>
  );
}

/* ── Tag input ───────────────────────────────────────────────────────── */
function TagInput({ onAdd, existingTags }: { onAdd: (tag: string) => void; existingTags: string[] }) {
  const [value, setValue] = useState('');

  const commit = () => {
    const t = value.trim().toLowerCase();
    if (t && !existingTags.includes(t)) onAdd(t);
    setValue('');
  };

  return (
    <input
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      }}
      placeholder="Add tag…"
      className="text-xs w-full border-b border-gray-200 pb-0.5 outline-none bg-transparent text-gray-600 placeholder-gray-300 focus:border-blue-400"
    />
  );
}

/* ── Main LeadPanel ──────────────────────────────────────────────────── */
interface LeadPanelProps {
  leadId: string;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export function LeadPanel({ leadId, onClose, onDelete }: LeadPanelProps) {
  const { user, setUser } = useSession();
  const [lead, setLead] = useState<Lead | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [loading, setLoading] = useState(true);
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
    setTranscripts([]);

    const h = { 'x-team-member-id': user.team_member_id, 'Content-Type': 'application/json' };
    const supabase = createClient();

    Promise.all([
      fetch(`/api/leads/${leadId}`, { headers: h }).then(r => r.json()),
      fetch(`/api/leads/${leadId}/interactions`, { headers: h }).then(r => r.json()),
      fetch(`/api/leads/${leadId}/action-items`, { headers: h }).then(r => r.json()),
      supabase.from('activity_log').select('*, team_member:team_members(id, name)').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30),
      supabase.from('team_members').select('id, name, email, gmail_connected, created_at'),
      supabase.from('transcripts').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }),
    ]).then(([leadRes, intRes, aiRes, actRes, memRes, transcriptRes]) => {
      if (leadRes.lead) {
        setLead(leadRes.lead);
        // Auto-switch session to lead owner (fall back to sourced_by) when opening a lead
        const ownerId = leadRes.lead.owned_by || leadRes.lead.sourced_by;
        if (ownerId && memRes.data) {
          const owner = (memRes.data as TeamMember[]).find((m: TeamMember) => m.id === ownerId);
          if (owner) setUser({ team_member_id: owner.id, name: owner.name });
        }
      }
      if (intRes.interactions) setInteractions(intRes.interactions);
      if (aiRes.action_items) setActionItems(aiRes.action_items);
      if (actRes.data) setActivities(actRes.data as ActivityLog[]);
      if (memRes.data) setMembers(memRes.data as TeamMember[]);
      if (transcriptRes.data) setTranscripts(transcriptRes.data as Transcript[]);
    }).finally(() => setLoading(false));
  }, [leadId, user]);

  // Scroll to bottom when timeline loads
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

  // When a transcript is uploaded or processed, upsert it in state
  const handleTranscriptUploaded = (t: Transcript) => {
    setTranscripts(prev => {
      const exists = prev.some(x => x.id === t.id);
      return exists ? prev.map(x => x.id === t.id ? t : x) : [t, ...prev];
    });
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
      {/* ── Left: timeline + compose ── */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">

        {/* Header */}
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

              {/* AI action */}
              <button onClick={handleSuggestAction} disabled={suggestingAction} title="AI suggested action" className="text-gray-300 hover:text-amber-500 transition-colors disabled:opacity-40">
                {suggestingAction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
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

          {/* Stage bar */}
          <StageBar lead={lead} onStageChange={handleStageChange} />

          {/* AI next action (if present) */}
          {lead.ai_next_action && (
            <div className="flex items-start gap-1.5 mt-2 px-2 py-1.5 bg-amber-50 rounded-lg">
              <Sparkles className="h-3 w-3 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{lead.ai_next_action}</p>
            </div>
          )}
        </div>

        {/* Thread (scrollable) */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4">
          {interactions.length === 0 && activities.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              No activity yet. Sync Gmail or add a note to start.
            </div>
          ) : (
            <LeadTimeline
              interactions={interactions}
              activities={activities}
              onReply={() => {
                const el = document.getElementById('compose-textarea');
                if (el) el.focus();
              }}
            />
          )}
          <NoteInput onAdd={handleAddNote} />
        </div>

        {/* Compose bar (pinned bottom) */}
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

      {/* ── Right: profile sidebar (always visible) ── */}
      <div className="w-72 flex-shrink-0 overflow-hidden flex flex-col">
        <ProfileSidebar
          lead={lead}
          members={members}
          actionItems={actionItems}
          transcripts={transcripts}
          memberId={user?.team_member_id || ''}
          headers={headers()}
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
          onTranscriptUploaded={handleTranscriptUploaded}
        />
      </div>
    </div>
  );
}

/* ── Quick note input ────────────────────────────────────────────────── */
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
        placeholder="Add a note…"
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
