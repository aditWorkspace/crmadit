'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { KnowledgeDoc, KnowledgeDocType, ProblemThemesData, ChatSession, ChatMessage } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Send, RefreshCw, Loader2, BookOpen, MessageSquare,
  AlertTriangle, MessageCircle, Lightbulb, Layers, Bot, User,
  Quote, Users, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  MessageSquarePlus, Trash2, Check, Sparkles, Brain, Search,
} from '@/lib/icons';

/* ─── Markdown → Structured Parsing ──────────────────────────────── */

interface ParsedEntry {
  date: string;
  leadName: string;
  company: string;
  items: ParsedItem[];
  quotes: ParsedQuote[];
}

interface ParsedItem {
  tag: string;       // e.g. "high", "medium", "positive", "concern", "suggestion"
  text: string;
}

interface ParsedQuote {
  quote: string;
  speaker: string;
  context: string;
}

interface ParsedSolutionItem {
  action: string;
  timing: string;
  reason: string;
}

interface ParsedSolutionEntry {
  date: string;
  leadName: string;
  company: string;
  items: ParsedSolutionItem[];
}

/** Split the markdown blob into sections by the "---\n### DATE — NAME (COMPANY)" header pattern */
function splitSections(content: string): Array<{ date: string; leadName: string; company: string; lines: string[] }> {
  if (!content?.trim()) return [];
  const sections = content.split(/\n---\n/).filter(s => s.trim());
  const results: Array<{ date: string; leadName: string; company: string; lines: string[] }> = [];

  for (const section of sections) {
    const headerMatch = section.match(/^###?\s*(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+?)\s*\(([^)]+)\)/);
    if (!headerMatch) continue;
    const [, date, leadName, company] = headerMatch;
    results.push({ date, leadName, company, lines: section.split('\n').slice(1) });
  }
  return results;
}

/** Parse problems / feedback docs into structured entries */
function parseTaggedEntries(content: string): ParsedEntry[] {
  return splitSections(content).flatMap(({ date, leadName, company, lines }) => {
    const items: ParsedItem[] = [];
    const quotes: ParsedQuote[] = [];
    let inQuotes = false;

    for (const line of lines) {
      const itemMatch = line.match(/^-\s*\*\*\[(\w+)]\*\*\s*(.+)/);
      if (itemMatch) {
        items.push({ tag: itemMatch[1], text: itemMatch[2] });
        continue;
      }
      if (line.includes('**Key quotes:**')) { inQuotes = true; continue; }
      if (inQuotes) {
        const quoteMatch = line.match(/^>\s*"(.+?)"\s*[—–-]\s*\*(.+?)\*\s*\(([^)]+)\)/);
        if (quoteMatch) {
          quotes.push({ quote: quoteMatch[1], speaker: quoteMatch[2], context: quoteMatch[3] });
        }
      }
    }
    return (items.length > 0 || quotes.length > 0) ? [{ date, leadName, company, items, quotes }] : [];
  });
}

/** Parse solutions doc into structured entries */
function parseSolutionEntries(content: string): ParsedSolutionEntry[] {
  return splitSections(content).flatMap(({ date, leadName, company, lines }) => {
    const items: ParsedSolutionItem[] = [];
    for (const line of lines) {
      const match = line.match(/^-\s*\*\*(.+?)\*\*\s*\(([^)]+)\)\s*[—–-]\s*(.+)/);
      if (match) items.push({ action: match[1], timing: match[2], reason: match[3] });
    }
    return items.length > 0 ? [{ date, leadName, company, items }] : [];
  });
}

/* ─── Tag/badge styling ──────────────────────────────────────────── */

const TAG_STYLES: Record<string, { bg: string; text: string }> = {
  high:       { bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
  medium:     { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  low:        { bg: 'bg-gray-50 border-gray-200', text: 'text-gray-600' },
  positive:   { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  concern:    { bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
  suggestion: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700' },
  question:   { bg: 'bg-purple-50 border-purple-200', text: 'text-purple-700' },
};

const DOC_CONFIG: Record<KnowledgeDocType, { label: string; icon: typeof AlertTriangle; color: string; title: string; subtitle: string }> = {
  problems:         { label: 'Problems', icon: AlertTriangle, color: 'text-red-600', title: 'Problems & Pain Points', subtitle: 'Insights from prospect discovery calls.' },
  product_feedback: { label: 'Feedback', icon: MessageCircle, color: 'text-blue-600', title: 'Product Feedback', subtitle: 'What prospects think about Proxi AI — likes, dislikes, suggestions.' },
  solutions:        { label: 'Solutions', icon: Lightbulb, color: 'text-green-600', title: 'Solutions & Ideas', subtitle: 'Workflow ideas, feature requests, and how prospects would use Proxi.' },
  problem_themes:   { label: 'Themes', icon: Layers, color: 'text-purple-600', title: 'Problem Themes', subtitle: 'Aggregated patterns across all discovery calls.' },
};

/* ─── Helpers ────────────────────────────────────────────────────── */

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

function FormattedMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const text = line.slice(2);
      elements.push(
        <div key={i} className="flex gap-2 items-start">
          <span className="text-gray-400 mt-0.5">•</span>
          <span>{renderBold(text)}</span>
        </div>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i}>{renderBold(line)}</p>);
    }
  }

  return <div className="space-y-1 leading-relaxed">{elements}</div>;
}

function renderBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

/* ─── Page Component ─────────────────────────────────────────────── */

export default function InsightsPage() {
  const { user } = useSession();
  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<KnowledgeDocType>('problems');
  const [aggregating, setAggregating] = useState(false);
  const [input, setInput] = useState('');

  // ── Multi-session chat state ──────────────────────────────────────
  // Each "key" is either a real session UUID or a transient draft key
  // (`__draft_<uuid>`) for a New Chat that hasn't sent its first message
  // yet. State per key lets multiple chats run in parallel — sending in
  // session A while viewing B keeps A's request alive, and switching back
  // to A shows its progress and final answer when ready.
  type SessionState = { messages: ChatMessage[]; loading: boolean; loadingStartedAt?: number };
  const newDraftKey = () => `__draft_${crypto.randomUUID()}`;
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>(() => ({ [newDraftKey()]: { messages: [], loading: false } }));
  // Pick the initial draft key. Re-derived only on first render.
  const [activeKey, setActiveKey] = useState<string>(() => Object.keys({ initial: 1 })[0] === 'initial' ? '' : '');
  // We need to set activeKey to the draft key created above. Done in an effect below.

  // ── Server-side session list (real sessions only) ────────────────
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const isDraftKey = (k: string) => k.startsWith('__draft_');
  const getState = (k: string): SessionState => sessionStates[k] ?? { messages: [], loading: false };
  const updateState = (k: string, updater: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => ({ ...prev, [k]: updater(prev[k] ?? { messages: [], loading: false }) }));
  };
  // Set initial activeKey to the first draft key (run once on mount).
  useEffect(() => {
    setActiveKey(prev => prev || Object.keys(sessionStates)[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Right-panel (knowledge docs) collapse state. Defaults to OPEN on first
  // mount but persisted to localStorage so the user's preference sticks.
  const [docsCollapsed, setDocsCollapsed] = useState(false);
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('insights:docsCollapsed') : null;
    if (stored === '1') setDocsCollapsed(true);
  }, []);
  const toggleDocs = () => {
    setDocsCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') window.localStorage.setItem('insights:docsCollapsed', next ? '1' : '0');
      return next;
    });
  };

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const fetchDocs = useCallback(async () => {
    try {
      setDocsLoading(true);
      const res = await fetch('/api/knowledge-docs', { headers });
      const data = await res.json();
      if (data.docs) setDocs(data.docs);
    } catch {
      // silent
    } finally {
      setDocsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.team_member_id]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  // ── Session management ──────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    try {
      setSessionsLoading(true);
      const res = await fetch('/api/chat-sessions', { headers });
      const data = await res.json();
      if (data.sessions) setSessions(data.sessions);
    } catch {
      // silent
    } finally {
      setSessionsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.team_member_id]);

  const loadSession = useCallback(async (sessionId: string) => {
    setActiveKey(sessionId);
    // If we already have state for this session and it's not actively
    // loading, show whatever's cached and skip the network round-trip.
    const cached = sessionStates[sessionId];
    if (cached && cached.messages.length > 0 && !cached.loading) return;
    try {
      const res = await fetch(`/api/chat-sessions/${sessionId}`, { headers });
      const data = await res.json();
      if (data.messages) {
        updateState(sessionId, prev => ({ ...prev, messages: data.messages, loading: prev.loading }));
      }
    } catch {
      // silent
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.team_member_id, sessionStates]);

  // Load session list on mount.
  useEffect(() => {
    if (!user) return;
    fetchSessions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.team_member_id]);

  const startNewChat = () => {
    const k = newDraftKey();
    setSessionStates(prev => ({ ...prev, [k]: { messages: [], loading: false } }));
    setActiveKey(k);
    inputRef.current?.focus();
  };

  const deleteSession = async (sessionId: string) => {
    try {
      await fetch(`/api/chat-sessions/${sessionId}`, { method: 'DELETE', headers });
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      // Drop cached state for the deleted session.
      setSessionStates(prev => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      if (activeKey === sessionId) startNewChat();
    } catch {
      // silent
    }
  };

  const handleAggregate = async () => {
    try {
      setAggregating(true);
      const res = await fetch('/api/knowledge-docs/aggregate-themes', { method: 'POST', headers });
      if (!res.ok) throw new Error('Aggregation failed');
      await fetchDocs();
    } catch {
      // silent
    } finally {
      setAggregating(false);
    }
  };

  // Auto-scroll when active session's messages change.
  const activeMessages = getState(activeKey).messages;
  const activeLoading = getState(activeKey).loading;
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length, activeKey]);

  // Non-blocking send. Captures the target key at send-time so that
  // switching sessions mid-flight updates the originating session, not
  // whatever the user is currently looking at.
  const handleSend = () => {
    const q = input.trim();
    if (!q) return;

    const targetKey = activeKey;
    const targetIsDraft = isDraftKey(targetKey);
    const targetSessionId = targetIsDraft ? null : targetKey;

    // Refuse if THIS session is already loading. Other sessions can still
    // be in-flight independently.
    if (getState(targetKey).loading) return;

    const tempUserMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: q,
      created_at: new Date().toISOString(),
    };
    updateState(targetKey, prev => ({
      ...prev,
      messages: [...prev.messages, tempUserMsg],
      loading: true,
      loadingStartedAt: Date.now(),
    }));
    setInput('');
    inputRef.current?.focus();

    // Fire-and-forget; resolve into the captured target key.
    (async () => {
      try {
        if (targetSessionId) {
          const res = await fetch(`/api/chat-sessions/${targetSessionId}/messages`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: q }),
          });
          const data = await res.json();
          if (data.error && !data.assistantMessage) throw new Error(data.error);

          updateState(targetSessionId, prev => ({
            ...prev,
            // Replace the optimistic user msg with the persisted versions.
            messages: [...prev.messages.slice(0, -1), data.userMessage, data.assistantMessage].filter(Boolean),
            loading: false,
          }));
          setSessions(prev => prev
            .map(s => s.id === targetSessionId ? { ...s, updated_at: new Date().toISOString() } : s)
            .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
          );
        } else {
          // New session — POST creates it server-side.
          const res = await fetch('/api/chat-sessions', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: q }),
          });
          const data = await res.json();
          if (data.error && !data.messages) throw new Error(data.error);

          const newId: string = data.session.id;
          // Promote draft state -> real session id. Drop the draft key.
          setSessionStates(prev => {
            const next = { ...prev };
            delete next[targetKey];
            next[newId] = { messages: data.messages, loading: false };
            return next;
          });
          // If the user is still viewing this draft, follow it to the new
          // session id; otherwise leave them where they are.
          setActiveKey(prev => prev === targetKey ? newId : prev);
          setSessions(prev => [data.session, ...prev]);
        }
        fetchDocs();
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'request failed';
        const errorMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Failed to get a response: ${detail}`,
          created_at: new Date().toISOString(),
        };
        // Use the post-promotion key if we promoted; otherwise stick with
        // the original target key.
        setSessionStates(prev => {
          const k = prev[targetKey] ? targetKey : Object.keys(prev).find(x => !isDraftKey(x) && prev[x].loading) ?? targetKey;
          const cur = prev[k] ?? { messages: [], loading: false };
          return { ...prev, [k]: { ...cur, messages: [...cur.messages, errorMsg], loading: false } };
        });
      }
    })();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activeDoc = docs.find(d => d.doc_type === activeTab);
  const activeSessionMeta = isDraftKey(activeKey) ? null : sessions.find(s => s.id === activeKey);
  // Sidebar items: real sessions + any drafts that have at least one
  // message (suppress empty drafts to avoid clutter).
  const sidebarDrafts = Object.entries(sessionStates)
    .filter(([k, st]) => isDraftKey(k) && (st.messages.length > 0 || st.loading))
    .map(([k, st]) => ({ key: k, st }));

  return (
    <div className="flex h-[calc(100vh-1rem)] gap-4 p-4">
      {/* ── Sidebar: chat list ──────────────────────────────────── */}
      <div className="flex flex-col w-[240px] flex-shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-3 pt-3 pb-2 border-b border-gray-100">
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessionsLoading && sessions.length === 0 ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 text-gray-300 animate-spin" />
            </div>
          ) : (
            <>
              {/* Drafts with content shown at top */}
              {sidebarDrafts.map(({ key, st }) => (
                <div
                  key={key}
                  onClick={() => setActiveKey(key)}
                  className={cn(
                    'group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                    activeKey === key ? 'bg-gray-100' : 'hover:bg-gray-50',
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                  <span className="flex-1 min-w-0 text-sm text-gray-700 truncate italic">
                    {st.messages[0]?.content?.slice(0, 40) || 'New chat'}
                  </span>
                  {st.loading && <Loader2 className="h-3 w-3 text-gray-400 animate-spin flex-shrink-0" />}
                </div>
              ))}
              {/* Empty draft slot if currently viewing one */}
              {isDraftKey(activeKey) && getState(activeKey).messages.length === 0 && (
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-gray-100">
                  <MessageSquarePlus className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                  <span className="flex-1 text-sm text-gray-700 truncate">New chat</span>
                </div>
              )}
              {/* Real sessions */}
              {sessions.map(s => {
                const isActive = activeKey === s.id;
                const isLoading = sessionStates[s.id]?.loading;
                return (
                  <div
                    key={s.id}
                    onClick={() => loadSession(s.id)}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                      isActive ? 'bg-gray-100' : 'hover:bg-gray-50',
                    )}
                  >
                    <MessageSquare className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 truncate">{s.title}</p>
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
                <p className="text-xs text-gray-400 text-center py-6">No chats yet</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Center: Chat ──────────────────────────────────────── */}
      <div className={cn(
        "flex flex-col min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm transition-all duration-300",
        docsCollapsed ? "flex-1" : "flex-1",
      )}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <MessageSquare className="h-4.5 w-4.5 text-gray-700 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-900 truncate">
              {activeSessionMeta?.title || 'New chat'}
            </span>
            {activeLoading && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                <Loader2 className="h-3 w-3 animate-spin" /> running
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleDocs}
              className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-50 transition-colors"
              title={docsCollapsed ? 'Show knowledge docs' : 'Hide knowledge docs'}
            >
              {docsCollapsed ? <ChevronLeft className="h-4.5 w-4.5" /> : <ChevronRight className="h-4.5 w-4.5" />}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {activeMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3 py-12">
              <div className="h-12 w-12 rounded-full bg-gray-50 flex items-center justify-center">
                <BookOpen className="h-6 w-6 text-gray-300" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">No messages yet</p>
                <p className="text-xs text-gray-400 mt-1 max-w-xs">
                  Ask questions about pain points, feedback, or ideas from your discovery calls.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 mt-2 justify-center">
                {[
                  'What are the top pain points?',
                  'Who gave positive product feedback?',
                  'What features do prospects want most?',
                ].map(q => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); inputRef.current?.focus(); }}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeMessages.map(msg => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
              {msg.role === 'assistant' && (
                <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="h-3.5 w-3.5 text-white" />
                </div>
              )}
              <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-50 text-gray-800 border border-gray-100'
              }`}>
                {msg.role === 'assistant'
                  ? <FormattedMarkdown content={msg.content} />
                  : <div className="whitespace-pre-wrap">{msg.content}</div>
                }
              </div>
              {msg.role === 'user' && (
                <div className="h-7 w-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <User className="h-3.5 w-3.5 text-white" />
                </div>
              )}
            </div>
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
              placeholder="Ask about your discovery calls..."
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

      {/* ── Right panel: Knowledge Docs ───────────────────────────── */}
      {!docsCollapsed && (
      <div className="flex flex-col w-[42%] min-w-0 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <BookOpen className="h-4.5 w-4.5 text-gray-700" />
            <h2 className="text-sm font-semibold text-gray-900">Knowledge Docs</h2>
          </div>
          <button
            onClick={fetchDocs}
            disabled={docsLoading}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-md hover:bg-gray-50"
            title="Refresh docs"
          >
            <RefreshCw className={`h-4 w-4 ${docsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as KnowledgeDocType)} className="flex flex-col flex-1 min-h-0">
          <TabsList className="mx-4 mt-3 mb-0 w-auto">
            {(Object.entries(DOC_CONFIG) as [KnowledgeDocType, typeof DOC_CONFIG.problems][]).map(([type, cfg]) => (
              <TabsTrigger key={type} value={type} className="flex items-center gap-1.5 text-xs">
                <cfg.icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                {cfg.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {(Object.keys(DOC_CONFIG) as KnowledgeDocType[]).map(type => (
            <TabsContent key={type} value={type} className="flex-1 overflow-y-auto px-5 py-4 m-0">
              {docsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 text-gray-300 animate-spin" />
                </div>
              ) : activeDoc && activeDoc.content?.trim() ? (
                <StructuredDocView doc={activeDoc} onAggregate={handleAggregate} aggregating={aggregating} />
              ) : (
                <p className="text-sm text-gray-400 text-center py-12">
                  No content yet. Process a transcript to start building insights.
                </p>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
      )}
    </div>
  );
}

/* ─── Thinking Indicator ──────────────────────────────────────────── */
// Multi-stage progress while the chat pipeline runs. Stage timing is
// approximate — the API doesn't stream progress yet, so we cycle through
// stages on a timer calibrated against typical end-to-end latency.
//   router (~1s) → retrieving (~2s) → debate (~25s) → judge (~30s)
// If a question is a lookup, the debate/judge steps still display but
// finish under their estimates and the answer arrives mid-stage. That's
// fine; the UI will just unmount when the response lands.
function ThinkingIndicator({ startedAt }: { startedAt?: number }) {
  const stages = [
    { label: 'Routing question', icon: Sparkles, durationMs: 2500 },
    { label: 'Searching transcripts', icon: Search, durationMs: 2500 },
    { label: 'Building case for + against (in parallel)', icon: Users, durationMs: 25000 },
    { label: 'Judge deliberating', icon: Brain, durationMs: 60000 },
  ];

  const [currentStage, setCurrentStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Use startedAt when provided so switching away and back resumes
    // the timer from when the request *actually* started, not from when
    // the indicator re-mounted.
    const start = startedAt ?? Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - start), 250);
    return () => clearInterval(tick);
  }, [startedAt]);

  useEffect(() => {
    let cumulative = 0;
    for (let i = 0; i < stages.length; i++) {
      cumulative += stages[i].durationMs;
      if (elapsed < cumulative) {
        setCurrentStage(i);
        return;
      }
    }
    setCurrentStage(stages.length - 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center flex-shrink-0">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 min-w-[260px] space-y-1.5">
        {stages.map((stage, i) => {
          const Icon = stage.icon;
          const isDone = i < currentStage;
          const isActive = i === currentStage;
          return (
            <div key={i} className="flex items-center gap-2.5 text-xs">
              <span className={cn(
                "h-4 w-4 rounded-full flex items-center justify-center flex-shrink-0",
                isDone ? "bg-emerald-100 text-emerald-700" : isActive ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-400",
              )}>
                {isDone ? (
                  <Check className="h-2.5 w-2.5" />
                ) : isActive ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Icon className="h-2.5 w-2.5" />
                )}
              </span>
              <span className={cn(
                isDone ? "text-gray-400 line-through decoration-gray-300" : isActive ? "text-gray-900 font-medium" : "text-gray-400",
              )}>
                {stage.label}
              </span>
            </div>
          );
        })}
        <div className="text-[10px] text-gray-400 pt-1 pl-6">
          {(elapsed / 1000).toFixed(0)}s elapsed
        </div>
      </div>
    </div>
  );
}

/* ─── Structured Doc Renderer ────────────────────────────────────── */

function StructuredDocView({ doc, onAggregate, aggregating }: { doc: KnowledgeDoc; onAggregate?: () => void; aggregating?: boolean }) {
  const config = DOC_CONFIG[doc.doc_type];

  if (doc.doc_type === 'problem_themes') {
    return <ProblemThemesView doc={doc} onAggregate={onAggregate} aggregating={aggregating} />;
  }

  if (doc.doc_type === 'solutions') {
    const entries = parseSolutionEntries(doc.content);
    return (
      <div className="space-y-2">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900">{config.title}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{config.subtitle}</p>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-400">No entries parsed.</p>
        ) : (
          entries.map((entry, i) => (
            <CollapsibleSolutionEntry key={i} entry={entry} />
          ))
        )}
        <DocFooter updatedAt={doc.updated_at} />
      </div>
    );
  }

  // Problems & Feedback tabs
  const entries = parseTaggedEntries(doc.content);
  return (
    <div className="space-y-2">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">{config.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{config.subtitle}</p>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-400">No entries parsed.</p>
      ) : (
        entries.map((entry, i) => (
          <CollapsibleTaggedEntry key={i} entry={entry} />
        ))
      )}
      <DocFooter updatedAt={doc.updated_at} />
    </div>
  );
}

/* ─── Collapsible Entry Components ──────────────────────────────── */

function CollapsibleTaggedEntry({ entry }: { entry: ParsedEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-gray-50 px-4 py-2.5 flex items-center justify-between hover:bg-gray-100 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-900">{entry.leadName}</span>
          <span className="text-xs text-gray-400">{entry.company}</span>
          <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{entry.items.length} items</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 font-mono">{entry.date}</span>
          {open ? <ChevronUp className="h-3.5 w-3.5 text-gray-400" /> : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
        </div>
      </button>
      {open && (
        <>
          <div className="divide-y divide-gray-50">
            {entry.items.map((item, j) => {
              const style = TAG_STYLES[item.tag] || TAG_STYLES.low;
              return (
                <div key={j} className="px-4 py-2.5 flex items-start gap-3">
                  <span className={cn(
                    'flex-shrink-0 mt-0.5 w-16 text-center py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide',
                    style.bg, style.text,
                  )}>
                    {item.tag}
                  </span>
                  <p className="text-sm text-gray-800 leading-snug">{item.text}</p>
                </div>
              );
            })}
          </div>
          {entry.quotes.length > 0 && (
            <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Quote className="h-3 w-3 text-gray-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Key Quotes</span>
              </div>
              {entry.quotes.map((q, k) => (
                <div key={k} className="pl-3 border-l-2 border-gray-200">
                  <p className="text-xs text-gray-600 italic leading-relaxed">&ldquo;{q.quote}&rdquo;</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {q.speaker} &middot; {q.context}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CollapsibleSolutionEntry({ entry }: { entry: ParsedSolutionEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-gray-50 px-4 py-2.5 flex items-center justify-between hover:bg-gray-100 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-900">{entry.leadName}</span>
          <span className="text-xs text-gray-400">{entry.company}</span>
          <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{entry.items.length} ideas</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 font-mono">{entry.date}</span>
          {open ? <ChevronUp className="h-3.5 w-3.5 text-gray-400" /> : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
        </div>
      </button>
      {open && (
        <div className="divide-y divide-gray-50">
          {entry.items.map((item, j) => (
            <div key={j} className="px-4 py-3 flex items-start gap-3">
              <Lightbulb className="h-3.5 w-3.5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{item.action}</p>
                {item.timing && (
                  <span className="text-[11px] text-gray-500">
                    <span className="font-medium text-gray-600">Timeline:</span> {item.timing}
                  </span>
                )}
                {item.reason && (
                  <p className="text-xs text-gray-500 mt-1">{item.reason}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Problem Themes View ───────────────────────────────────────── */

function ProblemThemesView({ doc, onAggregate, aggregating }: { doc: KnowledgeDoc; onAggregate?: () => void; aggregating?: boolean }) {
  let data: ProblemThemesData = { themes: [], generated_at: null };
  try { data = JSON.parse(doc.content); } catch { /* keep empty */ }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Problem Themes</h3>
          <p className="text-xs text-gray-500 mt-0.5">Aggregated patterns across all discovery calls.</p>
        </div>
        {onAggregate && (
          <button
            onClick={onAggregate}
            disabled={aggregating}
            className="flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-700 disabled:opacity-50 px-3 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 transition-colors"
          >
            {aggregating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {aggregating ? 'Aggregating...' : 'Re-aggregate'}
          </button>
        )}
      </div>

      {data.themes.length === 0 ? (
        <div className="text-center py-12">
          <Layers className="h-8 w-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-400">No themes yet.</p>
          <p className="text-xs text-gray-400 mt-1">Click &ldquo;Re-aggregate&rdquo; to analyze pain points across all calls.</p>
        </div>
      ) : (
        data.themes.map((theme, i) => {
          const sevStyle = TAG_STYLES[theme.severity] || TAG_STYLES.low;
          return (
            <div key={i} className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 flex items-start gap-3">
                <span className={cn(
                  'flex-shrink-0 mt-0.5 w-16 text-center py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide',
                  sevStyle.bg, sevStyle.text,
                )}>
                  {theme.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{theme.theme}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Users className="h-3 w-3 text-gray-400" />
                    <span className="text-[11px] text-gray-500">{theme.frequency} lead{theme.frequency !== 1 ? 's' : ''} mentioned this</span>
                  </div>
                </div>
              </div>
              {theme.leads.length > 0 && (
                <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-2.5 space-y-1.5">
                  {theme.leads.map((lead, k) => (
                    <div key={k} className="flex items-start gap-2">
                      <span className="text-[11px] font-medium text-gray-600 flex-shrink-0">{lead.name} ({lead.company}):</span>
                      <span className="text-[11px] text-gray-500">{lead.pain_point}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {data.generated_at && (
        <p className="text-xs text-gray-400 mt-6 pt-4 border-t border-gray-100">
          Last aggregated: {new Date(data.generated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function DocFooter({ updatedAt }: { updatedAt: string }) {
  if (!updatedAt) return null;
  return (
    <p className="text-xs text-gray-400 mt-6 pt-4 border-t border-gray-100">
      Last updated: {new Date(updatedAt).toLocaleString()}
    </p>
  );
}
