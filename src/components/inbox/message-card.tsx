'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { ownerColor } from '@/lib/colors';
import { ChevronDown, ChevronRight } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import type { ThreadDetailMessage } from '@/hooks/use-thread-detail';

interface MessageCardProps {
  message: ThreadDetailMessage;
  leadContactName: string | null;
}

/** Split a plain-text email body into (visible, quoted) halves. */
function splitQuotedText(body: string): { visible: string; quoted: string } {
  if (!body) return { visible: '', quoted: '' };
  const lines = body.split('\n');

  const onWroteIdx = lines.findIndex(l =>
    /^\s*On\s.+?\s+wrote:\s*$/i.test(l.trim())
  );
  if (onWroteIdx !== -1) {
    return {
      visible: lines.slice(0, onWroteIdx).join('\n').trimEnd(),
      quoted: lines.slice(onWroteIdx).join('\n'),
    };
  }

  let quoteStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i])) {
      if (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
        quoteStart = i;
        break;
      }
    }
  }
  if (quoteStart > 0) {
    return {
      visible: lines.slice(0, quoteStart).join('\n').trimEnd(),
      quoted: lines.slice(quoteStart).join('\n'),
    };
  }

  return { visible: body, quoted: '' };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function relativeTime(iso: string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const min = Math.round(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function fullTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function MessageCard({ message, leadContactName }: MessageCardProps) {
  const { user } = useSession();
  const [quotedOpen, setQuotedOpen] = useState(false);

  const isInbound = message.type === 'email_inbound';
  const senderName = isInbound
    ? leadContactName || 'Prospect'
    : message.team_member?.name || 'Us';
  const isSelf = !isInbound && user?.name === message.team_member?.name;
  const oc = ownerColor(isInbound ? null : message.team_member?.name);

  const { visible, quoted } = useMemo(
    () => splitQuotedText(message.body ?? ''),
    [message.body]
  );
  const displayBody = visible || message.summary || '(no content)';

  const recipientLine = isInbound
    ? 'to us'
    : `to ${leadContactName || 'prospect'}`;

  return (
    <div
      className={cn(
        'group rounded-lg border transition-shadow hover:shadow-sm',
        isInbound
          ? 'bg-white border-gray-200'
          : 'bg-blue-50/60 border-blue-100 border-l-4 border-l-blue-400'
      )}
    >
      <div className="flex items-start gap-3 p-3 pb-2">
        <div
          className={cn(
            'h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0',
            isInbound ? 'bg-gray-200 text-gray-700' : cn(oc.bg, oc.text)
          )}
          aria-hidden
        >
          {initials(senderName)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] font-semibold text-gray-900 truncate">
                {senderName}
                {isSelf && (
                  <span className="ml-1 font-normal text-gray-500">(you)</span>
                )}
              </span>
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0',
                  isInbound
                    ? 'bg-gray-100 text-gray-600'
                    : 'bg-blue-100 text-blue-700'
                )}
              >
                {isInbound ? 'Inbound' : 'Outbound'}
              </span>
            </div>
            <span
              className="text-[11px] text-gray-400 flex-shrink-0"
              title={fullTime(message.occurred_at)}
            >
              {relativeTime(message.occurred_at)}
            </span>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">{recipientLine}</div>
        </div>
      </div>

      <div className="px-3 pb-3 pl-[60px]">
        <div className="prose-chat whitespace-pre-wrap text-[13px] text-gray-800 leading-relaxed">
          {displayBody}
        </div>

        {quoted && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setQuotedOpen(v => !v)}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 transition-colors"
            >
              {quotedOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {quotedOpen ? 'Hide quoted text' : 'Show quoted text'}
            </button>
            {quotedOpen && (
              <pre className="mt-2 whitespace-pre-wrap text-[11px] text-gray-500 border-l-2 border-gray-200 pl-3 font-sans">
                {quoted}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
