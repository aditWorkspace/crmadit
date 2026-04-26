'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Send, Loader2, MessageSquare, MessageSquarePlus, Trash2, Bot, User, Zap,
  Sparkles, Search, Brain, Check, Download, X,
} from '@/lib/icons';
import { ConfirmationCard, type ConfirmationState } from '@/components/actions/confirmation-card';

// ─── Types reflecting the persisted action_chat_messages content shape
// (see route.ts for what we save). Server is source of truth; the client
// just renders.

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

interface AssistantContent { text: string; tool_calls?: ToolCall[] }

interface ToolOutcomeRead {
  kind: 'read';
  tool_call_id: string;
  tool_name: string;
  data: ReadResultData;
}
interface ToolOutcomeMutationPreview {
  kind: 'mutation_preview';
  tool_call_id: string;
  tool_name: string;
  pending_id: string;
  preview: { summary: string; affected: PreviewRow[]; warnings?: string[]; side_effects?: string[] };
}
interface ToolOutcomeMutationResult {
  kind: 'mutation_result';
  tool_call_id: string;
  tool_name: string;
  data: unknown;
}
interface ToolOutcomeMutationCancelled {
  kind: 'mutation_cancelled';
  tool_call_id: string;
  tool_name: string;
}
interface ToolOutcomeError { kind: 'error'; tool_call_id: string; tool_name: string; error: string }

type ToolOutcome = ToolOutcomeRead | ToolOutcomeMutationPreview | ToolOutcomeMutationResult | ToolOutcomeMutationCancelled | ToolOutcomeError;

interface PreviewRow { lead_id: string; contact_name: string; company_name: string; before: string; after: string }

type ReadResultData =
  | { kind: 'lead_list'; leads: LeadSummary[]; total: number }
  | { kind: 'lead_detail'; lead: LeadDetail }
  | { kind: 'count'; total: number; breakdown?: Record<string, number> }
  | { kind: 'activity'; entries: ActivityEntry[] }
  | { kind: 'csv'; url: string; filename: string; row_count: number }
  | { kind: 'message'; text: string };

interface LeadSummary {
  id: string; contact_name: string; contact_email: string; company_name: string;
  stage: string; priority: string; owned_by_name?: string; last_contact_at?: string;
  call_scheduled_for?: string; tags?: string[]; heat_score?: number;
}
interface LeadDetail extends LeadSummary {
  contact_role?: string; company_url?: string; call_completed_at?: string; demo_sent_at?: string;
  pinned_note?: string; call_summary?: string; next_steps?: string;
  recent_interactions: Array<{ type: string; summary?: string; subject?: string; created_at: string }>;
  recent_action_items: Array<{ text: string; completed: boolean; due_date?: string }>;
}
interface ActivityEntry {
  action: string; details?: Record<string, unknown>; actor?: string;
  lead?: { id: string; name: string; company: string }; created_at: string;
}

interface ToolMessageContent { tool_call_id: string; tool_name: string; outcome: ToolOutcome }

interface ChatMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: AssistantContent | ToolMessageContent | { text: string };
  created_at: string;
}

interface SessionMeta { id: string; title: string | null; updated_at: string; created_at: string }

type SessionState = { messages: ChatMessageRow[]; loading: boolean; loadingStartedAt?: number };

const DRAFT_PREFIX = '__draft_';

function newDraftKey() { return `${DRAFT_PREFIX}${crypto.randomUUID()}`; }
function isDraftKey(k: string) { return k.startsWith(DRAFT_PREFIX); }

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

const SAMPLE_PROMPTS = [
  'How many leads in scheduling?',
  'Show me everyone in demo_sent contacted in the last 8 days',
  "What's the status of Roop Pal?",
  'CSV of all leads I own',
  'Move Heath @ Stackpack to call_completed',
];

/* ─── Page ─────────────────────────────────────────────────────────── */

export default function ActionsPage() {
  const { user } = useSession();

  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>(() => ({ [newDraftKey()]: { messages: [], loading: false } }));
  const [activeKey, setActiveKey] = useState<string>(() => Object.keys({ initial: 1 })[0] === 'initial' ? '' : '');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [input, setInput] = useState('');

  // Per-pending-action state (overrides what's stored on the server when
  // the user just confirmed/cancelled it locally).
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, ConfirmationState>>({});

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Set initial activeKey to the first draft key on mount.
  useEffect(() => { setActiveKey(prev => prev || Object.keys(sessionStates)[0]); }, [sessionStates]);

  const getState = (k: string): SessionState => sessionStates[k] ?? { messages: [], loading: false };
  const updateState = (k: string, fn: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => ({ ...prev, [k]: fn(prev[k] ?? { messages: [], loading: false }) }));
  };

  const fetchSessions = useCallback(async () => {
    if (!user) return;
    try {
      setSessionsLoading(true);
      const res = await fetch('/api/action-chat');
      const data = await res.json();
      if (data.sessions) setSessions(data.sessions);
    } catch {} finally { setSessionsLoading(false); }
  }, [user]);
  useEffect(() => { if (user) fetchSessions(); }, [user, fetchSessions]);

  const loadSession = useCallback(async (sessionId: string) => {
    setActiveKey(sessionId);
    const cached = sessionStates[sessionId];
    if (cached && cached.messages.length > 0 && !cached.loading) return;
    try {
      const res = await fetch(`/api/action-chat/sessions/${sessionId}`);
      const data = await res.json();
      if (data.messages) updateState(sessionId, prev => ({ ...prev, messages: data.messages }));
    } catch {}
  }, [sessionStates]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNewChat = () => {
    const k = newDraftKey();
    setSessionStates(prev => ({ ...prev, [k]: { messages: [], loading: false } }));
    setActiveKey(k);
    inputRef.current?.focus();
  };

  const deleteSession = async (id: string) => {
    try {
      await fetch(`/api/action-chat/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== id));
      setSessionStates(prev => { const next = { ...prev }; delete next[id]; return next; });
      if (activeKey === id) startNewChat();
    } catch {}
  };

  const activeMessages = getState(activeKey).messages;
  const activeLoading = getState(activeKey).loading;

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeMessages.length, activeKey]);

  const handleSend = () => {
    const q = input.trim();
    if (!q || activeLoading) return;
    const targetKey = activeKey;
    const targetIsDraft = isDraftKey(targetKey);
    const sessionId = targetIsDraft ? null : targetKey;

    const tempUserMsg: ChatMessageRow = {
      id: crypto.randomUUID(),
      role: 'user',
      content: { text: q },
      created_at: new Date().toISOString(),
    };
    updateState(targetKey, prev => ({ ...prev, messages: [...prev.messages, tempUserMsg], loading: true, loadingStartedAt: Date.now() }));
    setInput('');
    inputRef.current?.focus();

    (async () => {
      try {
        const res = await fetch('/api/action-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: q, session_id: sessionId }),
        });
        const data = await res.json();
        if (data.error && !data.messages) throw new Error(data.error);

        const newSessionId: string = data.session_id;

        if (targetIsDraft) {
          setSessionStates(prev => {
            const next = { ...prev };
            delete next[targetKey];
            const draftMessages = (prev[targetKey]?.messages ?? []).slice(0, -1); // drop tempUser
            next[newSessionId] = {
              messages: [...draftMessages, { id: crypto.randomUUID(), role: 'user', content: { text: q }, created_at: new Date().toISOString() }, ...(data.messages ?? [])],
              loading: false,
            };
            return next;
          });
          setActiveKey(prev => prev === targetKey ? newSessionId : prev);
          if (data.created_session) setSessions(prev => [data.created_session, ...prev]);
        } else {
          updateState(newSessionId, prev => ({
            ...prev,
            messages: [...prev.messages.slice(0, -1), { id: crypto.randomUUID(), role: 'user', content: { text: q }, created_at: new Date().toISOString() }, ...(data.messages ?? [])],
            loading: false,
          }));
          setSessions(prev => prev.map(s => s.id === newSessionId ? { ...s, updated_at: new Date().toISOString() } : s)
            .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()));
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'request failed';
        updateState(targetKey, prev => ({
          ...prev,
          messages: [...prev.messages, { id: crypto.randomUUID(), role: 'assistant', content: { text: `Failed: ${detail}` }, created_at: new Date().toISOString() }],
          loading: false,
        }));
      }
    })();
  };

  const onConfirm = async (pending_id: string) => {
    setPendingOverrides(prev => ({ ...prev, [pending_id]: { kind: 'confirmed' } }));
    try {
      const res = await fetch('/api/action-chat/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'confirm failed');
      // Reload current session to pick up the new tool result message.
      if (!isDraftKey(activeKey)) await loadSession(activeKey);
    } catch (err) {
      setPendingOverrides(prev => ({ ...prev, [pending_id]: { kind: 'pending', pending_id, preview: { summary: 'Retry?', affected: [], warnings: [(err as Error).message] } } }));
    }
  };
  const onCancel = async (pending_id: string) => {
    setPendingOverrides(prev => ({ ...prev, [pending_id]: { kind: 'cancelled' } }));
    try {
      await fetch('/api/action-chat/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id }),
      });
    } catch {}
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activeSessionMeta = isDraftKey(activeKey) ? null : sessions.find(s => s.id === activeKey);
  const sidebarDrafts = Object.entries(sessionStates)
    .filter(([k, st]) => isDraftKey(k) && (st.messages.length > 0 || st.loading))
    .map(([k, st]) => ({ key: k, st }));

  return (
    <div className="flex h-[calc(100vh-1rem)] gap-4 p-4">
      {/* Sidebar */}
      <div className="flex flex-col w-[240px] flex-shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-3 pt-3 pb-2 border-b border-gray-100">
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New action
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessionsLoading && sessions.length === 0 ? (
            <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 text-gray-300 animate-spin" /></div>
          ) : (
            <>
              {sidebarDrafts.map(({ key, st }) => (
                <div
                  key={key}
                  onClick={() => setActiveKey(key)}
                  className={cn('group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                    activeKey === key ? 'bg-gray-100' : 'hover:bg-gray-50')}
                >
                  <MessageSquare className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                  <span className="flex-1 min-w-0 text-sm text-gray-700 truncate italic">
                    {(() => {
                      const first = st.messages[0]?.content as { text?: string } | undefined;
                      return first?.text?.slice(0, 40) || 'New action';
                    })()}
                  </span>
                  {st.loading && <Loader2 className="h-3 w-3 text-gray-400 animate-spin flex-shrink-0" />}
                </div>
              ))}
              {isDraftKey(activeKey) && getState(activeKey).messages.length === 0 && (
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-gray-100">
                  <MessageSquarePlus className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                  <span className="flex-1 text-sm text-gray-700 truncate">New action</span>
                </div>
              )}
              {sessions.map(s => {
                const isActive = activeKey === s.id;
                const isLoading = sessionStates[s.id]?.loading;
                return (
                  <div
                    key={s.id}
                    onClick={() => loadSession(s.id)}
                    className={cn('group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                      isActive ? 'bg-gray-100' : 'hover:bg-gray-50')}
                  >
                    <MessageSquare className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 truncate">{s.title || 'Untitled'}</p>
                      <p className="text-[10px] text-gray-400">{formatRelativeTime(s.updated_at)}</p>
                    </div>
                    {isLoading ? (
                      <Loader2 className="h-3 w-3 text-gray-500 animate-spin flex-shrink-0" />
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all flex-shrink-0"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
              {sessions.length === 0 && sidebarDrafts.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">No actions yet</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Center */}
      <div className="flex-1 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <Zap className="h-4.5 w-4.5 text-gray-700 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-900 truncate">
              {activeSessionMeta?.title || 'New action'}
            </span>
            {activeLoading && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                <Loader2 className="h-3 w-3 animate-spin" /> running
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {activeMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3 py-12">
              <div className="h-12 w-12 rounded-full bg-gray-50 flex items-center justify-center">
                <Zap className="h-6 w-6 text-gray-300" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Bulk CRM actions in plain English</p>
                <p className="text-xs text-gray-400 mt-1 max-w-md">
                  Ask for lookups, exports, or bulk updates. Mutations preview before they run; bulk &gt;25 leads requires typed confirmation.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 mt-2 justify-center max-w-md">
                {SAMPLE_PROMPTS.map(p => (
                  <button
                    key={p}
                    onClick={() => { setInput(p); inputRef.current?.focus(); }}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                  >{p}</button>
                ))}
              </div>
            </div>
          )}

          {activeMessages.map(msg => (
            <MessageRow
              key={msg.id}
              msg={msg}
              pendingOverrides={pendingOverrides}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          ))}

          {activeLoading && <ThinkingIndicator startedAt={getState(activeKey).loadingStartedAt} />}
          <div ref={chatEndRef} />
        </div>

        <div className="px-5 pb-4 pt-2 border-t border-gray-100">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Move Roop and Heath to demo_sent…"
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-300 placeholder:text-gray-400"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || activeLoading}
              size="sm"
              className="h-10 w-10 rounded-xl p-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Message renderers ────────────────────────────────────────────── */

function MessageRow({ msg, pendingOverrides, onConfirm, onCancel }: {
  msg: ChatMessageRow;
  pendingOverrides: Record<string, ConfirmationState>;
  onConfirm: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  if (msg.role === 'user') {
    const c = msg.content as { text: string };
    return (
      <div className="flex gap-3 justify-end">
        <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-gray-900 text-white whitespace-pre-wrap">{c.text}</div>
        <div className="h-7 w-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
          <User className="h-3.5 w-3.5 text-white" />
        </div>
      </div>
    );
  }
  if (msg.role === 'assistant') {
    const c = msg.content as AssistantContent;
    if (!c.text?.trim() && !c.tool_calls?.length) return null;
    return (
      <div className="flex gap-3">
        <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bot className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-gray-50 text-gray-800 border border-gray-100 whitespace-pre-wrap">
          {c.text || <span className="text-gray-400 italic">(used tools)</span>}
        </div>
      </div>
    );
  }
  // tool message
  const c = msg.content as ToolMessageContent;
  return <ToolOutcomeCard outcome={c.outcome} pendingOverrides={pendingOverrides} onConfirm={onConfirm} onCancel={onCancel} />;
}

function ToolOutcomeCard({ outcome, pendingOverrides, onConfirm, onCancel }: {
  outcome: ToolOutcome;
  pendingOverrides: Record<string, ConfirmationState>;
  onConfirm: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  if (outcome.kind === 'mutation_preview') {
    const override = pendingOverrides[outcome.pending_id];
    const state: ConfirmationState = override ?? { kind: 'pending', pending_id: outcome.pending_id, preview: outcome.preview };
    return (
      <div className="flex gap-3">
        <div className="h-7 w-7 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-700" />
        </div>
        <div className="flex-1 min-w-0 max-w-[90%]">
          <ConfirmationCard state={state} onConfirm={onConfirm} onCancel={onCancel} />
        </div>
      </div>
    );
  }
  if (outcome.kind === 'mutation_result') {
    return (
      <div className="flex gap-3">
        <div className="h-7 w-7 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Check className="h-3.5 w-3.5 text-emerald-700" />
        </div>
        <div className="flex-1 max-w-[90%] border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-2.5 text-sm text-emerald-900">
          <div className="font-medium">{outcome.tool_name} executed</div>
          <pre className="mt-1 text-[11px] text-emerald-800 whitespace-pre-wrap font-mono">{JSON.stringify(outcome.data, null, 2)}</pre>
        </div>
      </div>
    );
  }
  if (outcome.kind === 'mutation_cancelled') {
    return (
      <div className="flex gap-3">
        <div className="w-7 flex-shrink-0" />
        <div className="text-xs text-gray-500 italic px-4 py-1">{outcome.tool_name} — cancelled</div>
      </div>
    );
  }
  if (outcome.kind === 'error') {
    return (
      <div className="flex gap-3">
        <div className="h-7 w-7 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5"><X className="h-3.5 w-3.5 text-red-700" /></div>
        <div className="flex-1 max-w-[90%] border border-red-200 bg-red-50 rounded-xl px-4 py-2.5 text-sm text-red-800">
          <div className="font-medium">{outcome.tool_name} failed</div>
          <pre className="mt-1 text-[11px] whitespace-pre-wrap font-mono">{outcome.error}</pre>
        </div>
      </div>
    );
  }
  // read result
  return <ReadResultCard outcome={outcome} />;
}

function ReadResultCard({ outcome }: { outcome: ToolOutcomeRead }) {
  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Search className="h-3.5 w-3.5 text-gray-600" />
      </div>
      <div className="flex-1 min-w-0 max-w-[90%] border border-gray-200 rounded-xl bg-white">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-700">
          {outcome.tool_name}
        </div>
        <div className="px-4 py-3 text-sm">
          <ReadResultBody data={outcome.data} />
        </div>
      </div>
    </div>
  );
}

function ReadResultBody({ data }: { data: ReadResultData }) {
  if (data.kind === 'message') return <p className="text-gray-700">{data.text}</p>;
  if (data.kind === 'count') {
    return (
      <div>
        <div className="text-2xl font-semibold text-gray-900">{data.total}</div>
        {data.breakdown && (
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {Object.entries(data.breakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-gray-500">{k}</span>
                <span className="font-medium text-gray-900">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (data.kind === 'csv') {
    return (
      <a href={data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline">
        <Download className="h-4 w-4" /> Download {data.filename} ({data.row_count} rows)
      </a>
    );
  }
  if (data.kind === 'lead_list') {
    return (
      <div>
        <div className="text-xs text-gray-500 mb-2">{data.leads.length} of {data.total}</div>
        <div className="overflow-x-auto -mx-4">
          <table className="min-w-full text-xs">
            <thead className="text-gray-500 bg-gray-50">
              <tr>
                <th className="text-left font-medium px-3 py-1.5">Name</th>
                <th className="text-left font-medium px-3 py-1.5">Company</th>
                <th className="text-left font-medium px-3 py-1.5">Stage</th>
                <th className="text-left font-medium px-3 py-1.5">Owner</th>
                <th className="text-left font-medium px-3 py-1.5">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map(l => (
                <tr key={l.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 text-gray-900">{l.contact_name}</td>
                  <td className="px-3 py-1.5 text-gray-600">{l.company_name}</td>
                  <td className="px-3 py-1.5"><span className="text-[10px] uppercase tracking-wide text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">{l.stage}</span></td>
                  <td className="px-3 py-1.5 text-gray-600">{l.owned_by_name ?? '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.last_contact_at ? formatRelativeTime(l.last_contact_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (data.kind === 'lead_detail') {
    const l = data.lead;
    return (
      <div className="space-y-2">
        <div>
          <span className="font-semibold text-gray-900">{l.contact_name}</span>
          <span className="text-gray-500"> @ {l.company_name}</span>
          {l.contact_role && <span className="text-gray-400"> · {l.contact_role}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wide">
          <span className="bg-gray-100 px-1.5 py-0.5 rounded">{l.stage}</span>
          <span className="bg-gray-100 px-1.5 py-0.5 rounded">{l.priority}</span>
          {l.owned_by_name && <span className="bg-gray-100 px-1.5 py-0.5 rounded">{l.owned_by_name}</span>}
        </div>
        {l.next_steps && <div><span className="text-gray-500">Next steps: </span><span className="text-gray-800">{l.next_steps}</span></div>}
        {l.recent_interactions.length > 0 && (
          <details>
            <summary className="text-xs text-blue-600 cursor-pointer">Recent ({l.recent_interactions.length})</summary>
            <ul className="mt-1 space-y-1 pl-4 text-xs text-gray-600">
              {l.recent_interactions.map((i, k) => (
                <li key={k}>{i.created_at.slice(0, 10)} · <span className="font-medium">{i.type}</span> {i.subject ? `— ${i.subject}` : ''}{i.summary ? ` — ${i.summary.slice(0, 80)}` : ''}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }
  if (data.kind === 'activity') {
    return (
      <ul className="space-y-1 text-xs text-gray-700">
        {data.entries.map((e, i) => (
          <li key={i}>
            <span className="text-gray-400 font-mono">{e.created_at.slice(5, 16)}</span>{' '}
            <span className="font-medium">{e.action}</span>{e.lead ? ` · ${e.lead.name} @ ${e.lead.company}` : ''}{e.actor ? ` · by ${e.actor}` : ''}
          </li>
        ))}
      </ul>
    );
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

/* ─── Thinking indicator (same shape as insights chat) ────────────── */

function ThinkingIndicator({ startedAt }: { startedAt?: number }) {
  const stages = [
    { label: 'Parsing intent', icon: Sparkles, durationMs: 3000 },
    { label: 'Querying CRM', icon: Search, durationMs: 5000 },
    { label: 'Building preview', icon: Brain, durationMs: 30000 },
  ];
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = startedAt ?? Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - start), 250);
    return () => clearInterval(tick);
  }, [startedAt]);
  // Derive current stage from elapsed; no setState needed.
  let currentStage = stages.length - 1;
  let cum = 0;
  for (let i = 0; i < stages.length; i++) {
    cum += stages[i].durationMs;
    if (elapsed < cum) { currentStage = i; break; }
  }

  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center flex-shrink-0">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 min-w-[260px] space-y-1.5">
        {stages.map((s, i) => {
          const Icon = s.icon;
          const done = i < currentStage;
          const active = i === currentStage;
          return (
            <div key={i} className="flex items-center gap-2.5 text-xs">
              <span className={cn('h-4 w-4 rounded-full flex items-center justify-center flex-shrink-0',
                done ? 'bg-emerald-100 text-emerald-700' : active ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-400')}>
                {done ? <Check className="h-2.5 w-2.5" /> : active ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Icon className="h-2.5 w-2.5" />}
              </span>
              <span className={cn(done ? 'text-gray-400 line-through decoration-gray-300' : active ? 'text-gray-900 font-medium' : 'text-gray-400')}>{s.label}</span>
            </div>
          );
        })}
        <div className="text-[10px] text-gray-400 pt-1 pl-6">{(elapsed / 1000).toFixed(0)}s elapsed</div>
      </div>
    </div>
  );
}

