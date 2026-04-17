'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Send, Sparkles, ChevronDown, Loader2 } from '@/lib/icons';
import { cn } from '@/lib/utils';

interface ConnectedMember { id: string; name: string; email: string; }

interface ComposeBarProps {
  leadId: string;
  toEmail: string;
  threadId: string | null;
  teamMemberId: string;
  aiSuggestion?: string | null;
  onSent: (interaction: unknown) => void;
}

export function ComposeBar({ leadId, toEmail, threadId, teamMemberId, aiSuggestion, onSent }: ComposeBarProps) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [connectedMembers, setConnectedMembers] = useState<ConnectedMember[]>([]);
  const [senderId, setSenderId] = useState(teamMemberId);
  // Keep sender in sync when auto-switch changes teamMemberId (e.g. opening a lead)
  useEffect(() => { setSenderId(teamMemberId); }, [teamMemberId]);
  const [showSenderMenu, setShowSenderMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch('/api/team/connected-members', { headers: { 'x-team-member-id': teamMemberId } })
      .then(r => r.json())
      .then(d => {
        if (d.members) setConnectedMembers(d.members);
      });
  }, [teamMemberId]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const handleDraft = async () => {
    if (!threadId) { toast.error('No email thread found for this lead'); return; }
    setDrafting(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/draft-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-team-member-id': teamMemberId },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Draft failed');
      setBody(data.draft || '');
      setTimeout(autoResize, 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate draft');
    } finally {
      setDrafting(false);
    }
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    if (!threadId) { toast.error('No email thread to reply to'); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-team-member-id': teamMemberId },
        body: JSON.stringify({ body, thread_id: threadId, to_email: toEmail, sender_member_id: senderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      toast.success('Email sent');
      setBody('');
      setTimeout(autoResize, 0);
      onSent(data.interaction);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const senderName = connectedMembers.find(m => m.id === senderId)?.name
    || connectedMembers[0]?.name
    || 'You';

  return (
    <div className="border-t border-gray-200 bg-white flex-shrink-0">
      {/* AI suggestion hint */}
      {aiSuggestion && !body && (
        <div className="px-4 pt-3 pb-0 flex items-start gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 leading-relaxed">{aiSuggestion}</p>
        </div>
      )}

      <div className="px-4 py-3 space-y-2">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={e => { setBody(e.target.value); autoResize(); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={threadId ? 'Reply in thread… (⌘↵ to send)' : 'No email thread yet — sync Gmail first'}
          disabled={!threadId}
          rows={1}
          style={{ height: '38px' }}
          className="w-full text-sm resize-none rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400 transition-colors"
        />

        {/* Action row */}
        <div className="flex items-center justify-between gap-3">
          {/* From selector */}
          {connectedMembers.length > 1 ? (
            <div className="relative">
              <button
                onClick={() => setShowSenderMenu(v => !v)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <span className="font-medium">{senderName}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {showSenderMenu && (
                <div className="absolute bottom-full left-0 mb-1 bg-white rounded-lg border border-gray-200 shadow-lg z-10 py-1 min-w-[140px]">
                  {connectedMembers.map(m => (
                    <button
                      key={m.id}
                      onClick={() => { setSenderId(m.id); setShowSenderMenu(false); }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50',
                        m.id === senderId ? 'text-blue-600 font-medium' : 'text-gray-700'
                      )}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="text-xs text-gray-400">
              {connectedMembers.length === 0 ? 'Connect Gmail in Settings' : `From: ${senderName}`}
            </span>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleDraft}
              disabled={drafting || !threadId}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40 transition-colors"
            >
              {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              AI Draft
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !body.trim() || !threadId}
              className="flex items-center gap-1.5 text-xs bg-gray-900 text-white rounded-lg px-3 py-1.5 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
