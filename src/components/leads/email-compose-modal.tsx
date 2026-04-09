'use client';

import { useState, useEffect } from 'react';
import { X, Send, Sparkles, ChevronDown, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { renderTemplate, buildTemplateContext } from '@/lib/email/template-engine';

interface ConnectedMember { id: string; name: string; email: string; }

interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string;
}

interface EmailComposeModalProps {
  leadId: string;
  threadId: string;
  toEmail: string;
  subject: string;
  teamMemberId: string;
  initialDraft?: string;
  contactName?: string;
  companyName?: string;
  onClose: () => void;
  onSent: (interaction: unknown) => void;
}

export function EmailComposeModal({
  leadId, threadId, toEmail, subject, teamMemberId,
  initialDraft, contactName, companyName, onClose, onSent,
}: EmailComposeModalProps) {
  const [body, setBody] = useState(initialDraft ?? '');
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [connectedMembers, setConnectedMembers] = useState<ConnectedMember[]>([]);
  const [senderId, setSenderId] = useState(teamMemberId);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    fetch('/api/team/connected-members', { headers: { 'x-team-member-id': teamMemberId } })
      .then(r => r.json())
      .then(d => {
        if (d.members) {
          setConnectedMembers(d.members);
          const self = d.members.find((m: ConnectedMember) => m.id === teamMemberId);
          setSenderId(self ? teamMemberId : d.members[0]?.id || teamMemberId);
        }
      });
  }, [teamMemberId]);

  // Fetch templates on mount
  useEffect(() => {
    fetch('/api/templates', { headers: { 'x-team-member-id': teamMemberId } })
      .then(r => r.json())
      .then(d => { if (d.templates) setTemplates(d.templates); })
      .catch(() => {}); // non-fatal
  }, [teamMemberId]);

  const handleGenerateDraft = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/draft-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-team-member-id': teamMemberId },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to generate draft'); return; }
      setBody(data.draft);
    } catch { toast.error('Failed to generate draft'); }
    finally { setGenerating(false); }
  };

  const handleSelectTemplate = (template: Template) => {
    const sender = connectedMembers.find(m => m.id === senderId);
    const ctx = buildTemplateContext({
      contactName: contactName ?? toEmail.split('@')[0],
      contactEmail: toEmail,
      companyName: companyName ?? '',
      senderName: sender?.name ?? '',
      senderEmail: sender?.email ?? '',
      originalSubject: subject,
    });
    setBody(renderTemplate(template.body, ctx));
    setShowTemplates(false);

    // Bump usage count in background
    fetch(`/api/templates/${template.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-team-member-id': teamMemberId },
      body: JSON.stringify({ usage_count_bump: true }),
    }).catch(() => {});
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-team-member-id': teamMemberId },
        body: JSON.stringify({ body: body.trim(), thread_id: threadId, subject, sender_member_id: senderId }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to send email'); return; }
      toast.success('Email sent');
      onSent(data.interaction);
      onClose();
    } catch { toast.error('Failed to send email'); }
    finally { setSending(false); }
  };

  const sender = connectedMembers.find(m => m.id === senderId);

  const CATEGORY_LABELS: Record<string, string> = {
    post_call: 'Post-Call',
    post_demo: 'Post-Demo',
    check_in: 'Check-in',
    booking: 'Booking',
    custom: 'Custom',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800">New Email</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        {/* Fields */}
        <div className="px-4 py-2 border-b border-gray-100 space-y-1.5 text-sm">
          {connectedMembers.length > 1 ? (
            <div className="flex items-center gap-2">
              <span className="w-14 text-right text-xs font-medium text-gray-400">From</span>
              <div className="relative">
                <select
                  value={senderId}
                  onChange={e => setSenderId(e.target.value)}
                  className="appearance-none pl-2 pr-7 py-0.5 text-sm text-gray-700 border border-gray-200 rounded-md outline-none focus:border-blue-400 bg-white cursor-pointer"
                >
                  {connectedMembers.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.email})</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-500">
              <span className="w-14 text-right text-xs font-medium">From</span>
              <span className="text-gray-700 text-sm">{sender?.name || 'You'} ({sender?.email})</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-gray-500">
            <span className="w-14 text-right text-xs font-medium">To</span>
            <span className="text-gray-700">{toEmail}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <span className="w-14 text-right text-xs font-medium">Subject</span>
            <span className="text-gray-700 truncate">{subject.startsWith('Re:') ? subject : `Re: ${subject}`}</span>
          </div>
        </div>

        {/* Body */}
        <textarea
          autoFocus
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
          placeholder="Write your reply..."
          className="flex-1 min-h-36 p-4 text-sm text-gray-700 resize-none outline-none placeholder:text-gray-400"
        />

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2">
            {/* Template picker */}
            <div className="relative">
              <button
                onClick={() => setShowTemplates(!showTemplates)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
              >
                <FileText className="h-3 w-3" />
                Templates
                <ChevronDown className="h-3 w-3" />
              </button>
              {showTemplates && templates.length > 0 && (
                <div className="absolute bottom-full left-0 mb-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 max-h-64 overflow-auto">
                  {templates.map(t => (
                    <button
                      key={t.id}
                      onClick={() => handleSelectTemplate(t)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                    >
                      <p className="text-sm font-medium text-gray-800 truncate">{t.name}</p>
                      <p className="text-[10px] text-gray-400">{CATEGORY_LABELS[t.category] ?? t.category}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleGenerateDraft}
              disabled={generating || sending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 disabled:opacity-40 transition-colors"
            >
              <Sparkles className="h-3 w-3" />
              {generating ? 'Generating...' : 'AI Draft'}
            </button>
            <span className="text-xs text-gray-400">⌘↵ to send</span>
          </div>
          <button
            onClick={handleSend}
            disabled={sending || !body.trim()}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
