'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { ownerColor } from '@/lib/colors';
import { ChevronDown, ChevronRight } from '@/lib/icons';
import type { ThreadDetailMessage } from '@/hooks/use-thread-detail';

interface MessageCardProps {
  message: ThreadDetailMessage;
  leadContactName: string | null;
}

/** Split a plain-text email body into (visible, quoted) halves. */
function splitQuotedText(body: string): { visible: string; quoted: string } {
  if (!body) return { visible: '', quoted: '' };
  const lines = body.split('\n');

  // Look for an "On <date> <name> wrote:" line (common Gmail / Apple Mail)
  const onWroteIdx = lines.findIndex(l =>
    /^\s*On\s.+?\s+wrote:\s*$/i.test(l.trim())
  );
  if (onWroteIdx !== -1) {
    return {
      visible: lines.slice(0, onWroteIdx).join('\n').trimEnd(),
      quoted: lines.slice(onWroteIdx).join('\n'),
    };
  }

  // Look for a block of consecutive "> " quoted lines after some content.
  let quoteStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i])) {
      // Require at least 2 consecutive quoted lines to avoid treating single ">" as quote.
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

export function MessageCard({ message, leadContactName }: MessageCardProps) {
  const [quotedOpen, setQuotedOpen] = useState(false);
  const isInbound = message.type === 'email_inbound';
  const senderName = isInbound
    ? leadContactName || 'Prospect'
    : message.team_member?.name || 'Us';
  const oc = ownerColor(isInbound ? null : message.team_member?.name);

  const { visible, quoted } = useMemo(
    () => splitQuotedText(message.body ?? ''),
    [message.body]
  );

  const displayBody = visible || message.summary || '(no content)';
  const when = (() => {
    try {
      return new Date(message.occurred_at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  })();

  return (
    <div className={cn('chat-card', isInbound ? 'bg-white' : 'bg-blue-50/30')}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn('h-2 w-2 rounded-full flex-shrink-0', oc.dot)}
            aria-hidden
          />
          <span className="text-[13px] font-medium text-gray-900 truncate">
            {senderName}
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
        <span className="text-xs text-gray-400 flex-shrink-0">{when}</span>
      </div>

      <div className="prose-chat whitespace-pre-wrap">{displayBody}</div>

      {quoted && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setQuotedOpen(v => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            {quotedOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {quotedOpen ? 'Hide quoted text' : 'Show quoted text'}
          </button>
          {quotedOpen && (
            <pre className="mt-2 whitespace-pre-wrap text-xs text-gray-500 border-l-2 border-gray-200 pl-3 font-sans">
              {quoted}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
