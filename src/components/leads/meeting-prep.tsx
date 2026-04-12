'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/types';
import { BookOpen, Clock, Loader2, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

export function MeetingPrep({ lead, headers }: { lead: Lead; headers: Record<string, string> }) {
  const [notes, setNotes] = useState(lead.call_prep_notes || '');
  const [status, setStatus] = useState(lead.call_prep_status || 'not_started');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (lead.call_prep_notes && lead.call_prep_notes !== notes) setNotes(lead.call_prep_notes);
    if (lead.call_prep_status && lead.call_prep_status !== status) setStatus(lead.call_prep_status);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.call_prep_notes, lead.call_prep_status]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus('generating');
    try {
      const res = await fetch(`/api/leads/${lead.id}/research`, {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (data.notes) {
        setNotes(data.notes);
        setStatus('completed');
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    } finally {
      setRefreshing(false);
    }
  };

  if (!['scheduled', 'call_completed'].includes(lead.stage) && !notes) return null;

  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-blue-100">
        <div className="flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-semibold text-blue-700">Meeting Prep</span>
          {status === 'completed' && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-[1px] rounded-full">Ready</span>}
          {status === 'generating' && <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-[1px] rounded-full">Generating...</span>}
          {status === 'failed' && <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-[1px] rounded-full">Failed</span>}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-[11px] text-blue-600 hover:text-blue-800 disabled:opacity-40 flex items-center gap-1"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {notes ? 'Refresh' : 'Generate'}
        </button>
      </div>

      {lead.call_scheduled_for && (
        <div className="px-3 py-1.5 text-[11px] text-blue-600 border-b border-blue-100 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Call: {new Date(lead.call_scheduled_for).toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
          })}
        </div>
      )}

      {notes ? (
        <div className="px-3 py-2 max-h-72 overflow-y-auto">
          <ReactMarkdown
            components={{
              h1: ({ children }) => <h1 className="text-sm font-bold text-gray-900 mt-3 mb-1.5 first:mt-0">{children}</h1>,
              h2: ({ children }) => <h2 className="text-[13px] font-semibold text-gray-800 mt-3 mb-1 first:mt-0 border-b border-gray-200 pb-1">{children}</h2>,
              h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-700 mt-2 mb-1">{children}</h3>,
              p: ({ children }) => <p className="text-xs text-gray-600 leading-relaxed mb-1.5">{children}</p>,
              ul: ({ children }) => <ul className="text-xs text-gray-600 space-y-1 mb-2 ml-3 list-disc">{children}</ul>,
              ol: ({ children }) => <ol className="text-xs text-gray-600 space-y-1 mb-2 ml-3 list-decimal">{children}</ol>,
              li: ({ children }) => <li className="leading-relaxed">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold text-gray-800">{children}</strong>,
              em: ({ children }) => <em className="italic text-gray-500">{children}</em>,
              hr: () => <hr className="my-2 border-gray-200" />,
              a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{children}</a>,
              blockquote: ({ children }) => <blockquote className="border-l-2 border-blue-200 pl-2 my-1.5 text-xs text-gray-500 italic">{children}</blockquote>,
            }}
          >
            {notes}
          </ReactMarkdown>
        </div>
      ) : status !== 'generating' ? (
        <div className="px-3 py-4 text-center text-xs text-gray-400">
          No research generated yet. Click &ldquo;Generate&rdquo; to create a meeting brief.
        </div>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-amber-600 flex items-center justify-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Researching company and contact...
        </div>
      )}
    </div>
  );
}
