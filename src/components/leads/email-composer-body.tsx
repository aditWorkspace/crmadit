'use client';

import { useEffect, useState } from 'react';
import { Send, Sparkles, ChevronDown, FileText } from '@/lib/icons';
import { toast } from 'sonner';
import { renderTemplate, buildTemplateContext } from '@/lib/email/template-engine';
import { cn } from '@/lib/utils';

export interface ConnectedMember {
  id: string;
  name: string;
  email: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string;
}

export interface EmailComposerBodyProps {
  leadId: string;
  threadId: string;
  toEmail: string;
  subject: string;
  teamMemberId: string;
  ownerMemberId?: string;
  initialDraft?: string;
  contactName?: string;
  companyName?: string;
  onSent: (interaction: unknown) => void;
  onCancel?: () => void;
  /** If true, renders with a thin, embedded look (for inbox inline use). */
  embedded?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  post_call: 'Post-Call',
  post_demo: 'Post-Demo',
  check_in: 'Check-in',
  booking: 'Booking',
  custom: 'Custom',
};

/**
 * Headless composer body — no modal chrome. Used by both EmailComposeModal
 * (wrapped in a Dialog) and the inbox inline composer.
 */
export function EmailComposerBody({
  leadId,
  threadId,
  toEmail,
  subject,
  teamMemberId,
  ownerMemberId,
  initialDraft,
  contactName,
  companyName,
  onSent,
  onCancel,
  embedded = false,
  autoFocus = true,
  className,
}: EmailComposerBodyProps) {
  const [body, setBody] = useState(initialDraft ?? '');
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const senderId = ownerMemberId || teamMemberId;
  const [senderInfo, setSenderInfo] = useState<ConnectedMember | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    fetch('/api/team/connected-members', {
      headers: { 'x-team-member-id': teamMemberId },
    })
      .then(r => r.json())
      .then(d => {
        if (d.members) {
          const owner = (d.members as ConnectedMember[]).find(m => m.id === senderId);
          if (owner) setSenderInfo(owner);
        }
      })
      .catch(() => {});
  }, [teamMemberId, senderId]);

  useEffect(() => {
    fetch('/api/templates', { headers: { 'x-team-member-id': teamMemberId } })
      .then(r => r.json())
      .then(d => {
        if (d.templates) setTemplates(d.templates);
      })
      .catch(() => {});
  }, [teamMemberId]);

  const handleGenerateDraft = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/draft-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': teamMemberId,
        },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to generate draft');
        return;
      }
      setBody(data.draft);
    } catch {
      toast.error('Failed to generate draft');
    } finally {
      setGenerating(false);
    }
  };

  const handleSelectTemplate = (template: EmailTemplate) => {
    const sender = senderInfo;
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

    fetch(`/api/templates/${template.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-team-member-id': teamMemberId,
      },
      body: JSON.stringify({ usage_count_bump: true }),
    }).catch(() => {});
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-team-member-id': teamMemberId,
        },
        body: JSON.stringify({
          body: body.trim(),
          thread_id: threadId,
          subject,
          sender_member_id: senderId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to send email');
        return;
      }
      toast.success('Email sent');
      onSent(data.interaction);
    } catch {
      toast.error('Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const sender = senderInfo;
  const displaySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  return (
    <div className={cn('flex flex-col', embedded ? 'min-h-32' : 'min-h-60', className)}>
      {!embedded && (
        <div className="px-4 py-2 border-b border-gray-100 space-y-1.5 text-sm">
          <div className="flex items-center gap-2 text-gray-500">
            <span className="w-14 text-right text-xs font-medium">From</span>
            <span className="text-gray-700 text-sm">
              {sender?.name || 'Loading...'} ({sender?.email || '...'})
            </span>
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <span className="w-14 text-right text-xs font-medium">To</span>
            <span className="text-gray-700">{toEmail}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <span className="w-14 text-right text-xs font-medium">Subject</span>
            <span className="text-gray-700 truncate">{displaySubject}</span>
          </div>
        </div>
      )}

      {embedded && (
        <div className="flex items-center gap-2 text-xs text-gray-500 px-3 pt-2 pb-1">
          <span className="font-medium text-gray-700">
            {sender?.name || '...'}
          </span>
          <span className="text-gray-300">→</span>
          <span>{toEmail}</span>
          <span className="ml-auto truncate text-gray-400">{displaySubject}</span>
        </div>
      )}

      <textarea
        autoFocus={autoFocus}
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
        placeholder="Write your reply..."
        className={cn(
          'flex-1 p-3 text-[13px] text-gray-700 resize-none outline-none placeholder:text-gray-400 bg-transparent',
          embedded ? 'min-h-24' : 'min-h-36'
        )}
      />

      <div
        className={cn(
          'flex items-center justify-between px-3 py-2 border-t border-gray-100',
          embedded ? 'bg-white' : 'bg-gray-50'
        )}
      >
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowTemplates(v => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
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
                    type="button"
                    onClick={() => handleSelectTemplate(t)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-800 truncate">{t.name}</p>
                    <p className="text-[10px] text-gray-400">
                      {CATEGORY_LABELS[t.category] ?? t.category}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleGenerateDraft}
            disabled={generating || sending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-md hover:bg-purple-100 disabled:opacity-40 transition-colors"
          >
            <Sparkles className="h-3 w-3" />
            {generating ? 'Generating...' : 'AI Draft'}
          </button>
          <span className="text-xs text-gray-400 hidden sm:inline">{'\u2318\u21B5 to send'}</span>
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !body.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-md hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            <Send className="h-3 w-3" />
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
