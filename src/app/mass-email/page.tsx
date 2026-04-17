'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { STAGE_LABELS, STAGE_COLORS, ACTIVE_STAGES } from '@/lib/constants';
import { LeadStage } from '@/types';
import {
  Send, Sparkles, Loader2, CheckCircle2, AlertTriangle,
  Search, Users, Mail, TestTube,
} from '@/lib/icons';
import { toast } from 'sonner';

interface LeadOption {
  id: string;
  contact_name: string;
  company_name: string;
  contact_email: string;
  stage: LeadStage;
}

interface ConnectedMember {
  id: string;
  name: string;
  email: string;
}

export default function MassEmailPage() {
  const { user } = useSession();
  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  // Lead selection state
  const [selectedStages, setSelectedStages] = useState<Set<LeadStage>>(new Set());
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Email compose state
  const [senderId, setSenderId] = useState('');
  const [connectedMembers, setConnectedMembers] = useState<ConnectedMember[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number } | null>(null);

  // Fetch connected members for "From" selector
  useEffect(() => {
    if (!user) return;
    fetch('/api/team/connected-members', { headers })
      .then(r => r.json())
      .then(d => {
        setConnectedMembers(d.members || []);
        // Default to current user if connected, else first connected
        const me = (d.members || []).find((m: ConnectedMember) => m.id === user.team_member_id);
        setSenderId(me?.id || (d.members?.[0]?.id ?? ''));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.team_member_id]);

  // Fetch leads when stage selection changes
  const fetchLeads = useCallback(async () => {
    if (selectedStages.size === 0) {
      setLeads([]);
      return;
    }
    setLeadsLoading(true);
    try {
      const stageParams = [...selectedStages].map(s => `stage=${s}`).join('&');
      const res = await fetch(`/api/leads?${stageParams}&limit=500`, { headers });
      const data = await res.json();
      const filtered = (data.leads || []).filter((l: LeadOption) => l.contact_email);
      setLeads(filtered);
      // Auto-select all when loading
      setSelectedIds(new Set(filtered.map((l: LeadOption) => l.id)));
    } catch {
      toast.error('Failed to load leads');
    } finally {
      setLeadsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStages, user?.team_member_id]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Filter leads by search
  const filteredLeads = leads.filter(l => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return l.contact_name.toLowerCase().includes(q)
      || l.company_name.toLowerCase().includes(q)
      || l.contact_email.toLowerCase().includes(q);
  });

  const toggleStage = (stage: LeadStage) => {
    setSelectedStages(prev => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
    setSelectedIds(new Set());
    setSendResult(null);
  };

  const toggleLead = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filteredLeads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredLeads.map(l => l.id)));
    }
  };

  const handleAiDraft = async () => {
    setDrafting(true);
    try {
      const stage = selectedStages.size === 1 ? [...selectedStages][0] : undefined;
      const res = await fetch('/api/mass-email/draft', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      const data = await res.json();
      if (data.subject) setSubject(data.subject);
      if (data.body) setBody(data.body);
      toast.success('Draft generated');
    } catch {
      toast.error('Failed to generate draft');
    } finally {
      setDrafting(false);
    }
  };

  const handleTestSend = async () => {
    if (!subject || !body) return toast.error('Subject and body are required');
    setSending(true);
    try {
      const res = await fetch('/api/mass-email/send', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_member_id: senderId,
          subject,
          body,
          is_test: true,
        }),
      });
      const data = await res.json();
      if (data.success) toast.success('Test email sent to your inbox!');
      else toast.error(data.error || 'Test send failed');
    } catch {
      toast.error('Test send failed');
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    if (!subject || !body) return toast.error('Subject and body are required');
    if (selectedIds.size === 0) return toast.error('Select at least one lead');

    const confirmed = window.confirm(
      `Send this email to ${selectedIds.size} lead${selectedIds.size === 1 ? '' : 's'}?\n\nSubject: ${subject}\n\nThis will BCC all selected contacts. They won't see each other.`
    );
    if (!confirmed) return;

    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch('/api/mass-email/send', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_member_id: senderId,
          lead_ids: [...selectedIds],
          subject,
          body,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSendResult({ sent: data.sent, failed: data.failed });
        toast.success(`Sent to ${data.sent} leads!`);
      } else {
        toast.error(data.error || 'Send failed');
      }
    } catch {
      toast.error('Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-1rem)] gap-4 p-4">
      {/* ── Left panel: Lead selector ──────────────────────────────────── */}
      <div className="flex flex-col w-[45%] min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-100">
          <Users className="h-4.5 w-4.5 text-gray-700" />
          <h2 className="text-sm font-semibold text-gray-900">Select Recipients</h2>
        </div>

        {/* Stage filter chips */}
        <div className="px-4 pt-3 pb-2">
          <p className="text-xs text-gray-500 mb-2">Filter by stage</p>
          <div className="flex flex-wrap gap-1.5">
            {ACTIVE_STAGES.map(stage => (
              <button
                key={stage}
                onClick={() => toggleStage(stage)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                  selectedStages.has(stage)
                    ? STAGE_COLORS[stage]
                    : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                {STAGE_LABELS[stage]}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search leads..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-300 placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* Select all bar */}
        {filteredLeads.length > 0 && (
          <div className="flex items-center justify-between px-5 py-2 border-b border-gray-100 bg-gray-50/50">
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.size === filteredLeads.length && filteredLeads.length > 0}
                onChange={toggleAll}
                className="rounded border-gray-300"
              />
              Select all ({filteredLeads.length})
            </label>
            <span className="text-xs font-medium text-gray-900">
              {selectedIds.size} selected
            </span>
          </div>
        )}

        {/* Lead list */}
        <div className="flex-1 overflow-y-auto">
          {leadsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 text-gray-300 animate-spin" />
            </div>
          ) : selectedStages.size === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">
              Select a stage above to load leads
            </p>
          ) : filteredLeads.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">
              No leads with email at selected stages
            </p>
          ) : (
            filteredLeads.map(lead => (
              <label
                key={lead.id}
                className={`flex items-center gap-3 px-5 py-2.5 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors ${
                  selectedIds.has(lead.id) ? 'bg-blue-50/40' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(lead.id)}
                  onChange={() => toggleLead(lead.id)}
                  className="rounded border-gray-300 flex-shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {lead.contact_name}
                    </span>
                    <span className="text-xs text-gray-400 truncate">
                      {lead.company_name}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate">{lead.contact_email}</p>
                </div>
              </label>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: Email composer ─────────────────────────────────── */}
      <div className="flex flex-col w-[55%] min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <Mail className="h-4.5 w-4.5 text-gray-700" />
            <h2 className="text-sm font-semibold text-gray-900">Compose Email</h2>
          </div>
          <Button
            onClick={handleAiDraft}
            disabled={drafting || selectedStages.size === 0}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI Draft
          </Button>
        </div>

        {/* From selector */}
        <div className="px-5 pt-4 pb-2">
          <label className="text-xs font-medium text-gray-500 mb-1 block">From</label>
          <select
            value={senderId}
            onChange={e => setSenderId(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          >
            {connectedMembers.map(m => (
              <option key={m.id} value={m.id}>{m.name} ({m.email})</option>
            ))}
          </select>
        </div>

        {/* Subject */}
        <div className="px-5 py-2">
          <label className="text-xs font-medium text-gray-500 mb-1 block">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Email subject..."
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 placeholder:text-gray-400"
          />
        </div>

        {/* Body */}
        <div className="px-5 py-2 flex-1 flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1 block">Body</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your email here..."
            className="flex-1 w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-gray-900/10 placeholder:text-gray-400 min-h-[200px]"
          />
        </div>

        {/* Send result */}
        {sendResult && (
          <div className={`mx-5 mb-2 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2 ${
            sendResult.failed === 0
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-yellow-50 text-yellow-700 border border-yellow-200'
          }`}>
            {sendResult.failed === 0 ? (
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            )}
            Sent to {sendResult.sent} leads{sendResult.failed > 0 ? `, ${sendResult.failed} failed` : ''}
          </div>
        )}

        {/* Action buttons */}
        <div className="px-5 pb-4 pt-2 border-t border-gray-100 flex items-center justify-between">
          <Button
            onClick={handleTestSend}
            disabled={sending || !subject || !body}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            <TestTube className="h-3.5 w-3.5" />
            Test Send to Me
          </Button>

          <Button
            onClick={handleSend}
            disabled={sending || !subject || !body || selectedIds.size === 0}
            size="sm"
            className="gap-1.5"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send to {selectedIds.size} Lead{selectedIds.size === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  );
}
