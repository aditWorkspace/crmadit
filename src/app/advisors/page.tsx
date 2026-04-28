'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Users, Plus, Loader2, Trash2, MessageSquare, CheckCircle, XCircle, RefreshCw,
} from '@/lib/icons';

type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface AdvisorTranscript {
  id: string;
  kind: 'advisor_call' | 'misc';
  participant_name: string;
  participant_context: string | null;
  raw_text?: string | null;
  ai_summary?: string | null;
  ai_sentiment?: string | null;
  ai_interest_level?: string | null;
  processing_status: ProcessingStatus;
  created_at: string;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function AdvisorsPage() {
  const { user } = useSession();
  const [items, setItems] = useState<AdvisorTranscript[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<AdvisorTranscript | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/cron/advisor-transcripts');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.transcripts || []);
    } catch (err) {
      toast.error(`Failed to load: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (user) fetchList(); }, [user, fetchList]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transcript? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/cron/advisor-transcripts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(prev => prev.filter(x => x.id !== id));
      if (activeId === id) { setActiveId(null); setActiveDetail(null); }
      toast.success('Deleted');
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  const loadDetail = async (id: string) => {
    setActiveId(id);
    setActiveDetail(null);
    try {
      const res = await fetch(`/api/cron/advisor-transcripts/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActiveDetail(data.transcript);
    } catch (err) {
      toast.error(`Load failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  const onUploaded = (t: AdvisorTranscript) => {
    setItems(prev => [t, ...prev]);
    setShowUpload(false);
    toast.success('Uploaded — AI processing in background');
    // Poll once after a short delay so the row's processing_status updates.
    setTimeout(fetchList, 8000);
  };

  return (
    <div className="flex h-[calc(100vh-1rem)] gap-4 p-4">
      {/* Left: list */}
      <div className="flex flex-col w-[40%] min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Users className="h-4.5 w-4.5 text-gray-700" />
            <span className="text-sm font-semibold text-gray-900">Advisor / misc transcripts</span>
            <span className="text-xs text-gray-400">({items.length})</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={fetchList}
              disabled={loading}
              className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-50 transition-colors"
              title="Refresh"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="inline-flex items-center gap-1.5 text-xs text-white bg-gray-900 hover:bg-gray-700 rounded-lg px-3 py-1.5 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Upload
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 text-gray-300 animate-spin" /></div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
              <Users className="h-8 w-8 text-gray-300" />
              <p className="text-sm text-gray-500">No advisor transcripts yet</p>
              <p className="text-xs text-gray-400 max-w-xs">Upload a call you had with an advisor, mentor, or anyone outside your prospect pipeline. The insights chat will index them so you can ask follow-up questions.</p>
            </div>
          ) : (
            items.map(t => (
              <div
                key={t.id}
                onClick={() => loadDetail(t.id)}
                className={cn('group flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                  activeId === t.id ? 'bg-gray-100' : 'hover:bg-gray-50')}
              >
                <MessageSquare className="h-3.5 w-3.5 text-gray-400 flex-shrink-0 mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{t.participant_name}</p>
                    <span className="text-[10px] uppercase tracking-wide text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{t.kind === 'misc' ? 'misc' : 'advisor'}</span>
                  </div>
                  {t.participant_context && (
                    <p className="text-xs text-gray-500 truncate">{t.participant_context}</p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-400">{formatRelativeTime(t.created_at)}</span>
                    <StatusPill status={t.processing_status} />
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all flex-shrink-0"
                ><Trash2 className="h-3 w-3" /></button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm">
        {!activeId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Select a transcript to view detail</div>
        ) : !activeDetail ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 text-gray-300 animate-spin" /></div>
        ) : (
          <DetailView t={activeDetail} />
        )}
      </div>

      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onUploaded={onUploaded} />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ProcessingStatus }) {
  if (status === 'completed') {
    return <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700"><CheckCircle className="h-2.5 w-2.5" />processed</span>;
  }
  if (status === 'failed') {
    return <span className="inline-flex items-center gap-0.5 text-[10px] text-red-700"><XCircle className="h-2.5 w-2.5" />failed</span>;
  }
  return <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-500"><Loader2 className="h-2.5 w-2.5 animate-spin" />processing</span>;
}

function DetailView({ t }: { t: AdvisorTranscript }) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">{t.participant_name}</h2>
          <span className="text-[10px] uppercase tracking-wide text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{t.kind === 'misc' ? 'misc' : 'advisor'}</span>
        </div>
        {t.participant_context && <p className="text-sm text-gray-600">{t.participant_context}</p>}
        <p className="text-xs text-gray-400 mt-1">{new Date(t.created_at).toLocaleString()}</p>
      </div>
      {t.ai_summary && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">AI summary</h3>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{t.ai_summary}</p>
        </section>
      )}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Transcript</h3>
        <div className="text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-lg p-3 whitespace-pre-wrap font-mono max-h-[60vh] overflow-y-auto">
          {t.raw_text ?? '(empty)'}
        </div>
      </section>
    </div>
  );
}

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: (t: AdvisorTranscript) => void }) {
  const [participantName, setParticipantName] = useState('');
  const [participantContext, setParticipantContext] = useState('');
  const [rawText, setRawText] = useState('');
  const [kind, setKind] = useState<'advisor_call' | 'misc'>('advisor_call');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!participantName.trim() || !rawText.trim()) {
      toast.error('Participant name and transcript text are required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/cron/advisor-transcripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant_name: participantName, participant_context: participantContext, raw_text: rawText, kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onUploaded(data.transcript);
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error('File too large (>5MB)'); return; }
    const text = await file.text();
    setRawText(text);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Upload advisor / misc transcript</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-700">Participant name *</label>
            <input
              type="text"
              value={participantName}
              onChange={e => setParticipantName(e.target.value)}
              placeholder="e.g. Sarah Chen"
              className="mt-1 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">Context (1-2 lines about who they are)</label>
            <textarea
              value={participantContext}
              onChange={e => setParticipantContext(e.target.value)}
              placeholder="ex-PM at Stripe, advising on pricing strategy"
              rows={2}
              className="mt-1 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 resize-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">Type</label>
            <div className="mt-1 flex gap-2">
              {(['advisor_call', 'misc'] as const).map(k => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={cn('px-3 py-1.5 text-xs rounded-lg border transition-colors',
                    kind === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}
                >{k === 'advisor_call' ? 'Advisor' : 'Misc'}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-700">Transcript text *</label>
              <label className="text-[11px] text-blue-600 hover:underline cursor-pointer">
                Upload .txt
                <input type="file" accept=".txt,text/plain" onChange={handleFile} className="hidden" />
              </label>
            </div>
            <textarea
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              placeholder="Paste the full transcript here…"
              rows={12}
              className="mt-1 w-full text-xs font-mono px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 resize-y min-h-[200px]"
            />
            <p className="text-[10px] text-gray-400 mt-1">{rawText.length} chars</p>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 disabled:opacity-50">Cancel</button>
          <Button onClick={submit} disabled={submitting} size="sm">
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            {submitting ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );
}
