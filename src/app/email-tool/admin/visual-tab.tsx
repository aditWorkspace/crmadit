'use client';

import { useEffect, useState, useCallback } from 'react';

interface Draft {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  industry: string | null;
  image_url: string | null;
  page_slug: string | null;
  subject: string | null;
  body: string | null;
  email_html: string | null;
  sender_account_id: string;
  sender_name: string;
  variant: string | null;
}
interface Founder { id: string; name: string; email: string }

const VARIANT_STYLE: Record<string, string> = {
  A: 'bg-blue-100 text-blue-700',
  B: 'bg-violet-100 text-violet-700',
  C: 'bg-amber-100 text-amber-700',
};
const VARIANT_LABEL: Record<string, string> = {
  A: 'mutual connection',
  B: 'research ask',
  C: 'prioritization question',
};

export function VisualTab() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [pagesBase, setPagesBase] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, string>>({}); // id -> action label
  const [editing, setEditing] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // image regenerate panel
  const [imgFor, setImgFor] = useState<string | null>(null);
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [imgCand, setImgCand] = useState<{ image_url: string; current_url: string | null } | null>(null);
  const [gen, setGen] = useState<{ enabled: boolean; ready: number; inflight: number; target: number } | null>(null);
  const [variant, setVariant] = useState<'all' | 'A' | 'B' | 'C'>('all');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = variant === 'all' ? '' : `?variant=${variant}`;
      const r = await fetch(`/api/cron/email-tool/draft/visual-list${qs}`).then(x => x.json());
      setDrafts(r.drafts ?? []);
      setFounders(r.founders ?? []);
      setPagesBase(r.pages_base_url ?? '');
      setCounts(r.counts ?? null);
    } finally { setLoading(false); }
  }, [variant]);
  useEffect(() => { load(); }, [load]);

  const loadGen = useCallback(async () => {
    try { const r = await fetch('/api/cron/email-tool/visual-gen-control').then(x => x.json()); if (!r.error) setGen(r); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadGen(); const t = setInterval(loadGen, 10000); return () => clearInterval(t); }, [loadGen]);

  async function toggleGen(action: 'start' | 'stop') {
    const r = await fetch('/api/cron/email-tool/visual-gen-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then(x => x.json());
    if (!r.error) setGen(r);
  }

  const setB = (id: string, label: string | null) =>
    setBusy(b => { const n = { ...b }; if (label) n[id] = label; else delete n[id]; return n; });

  async function action(id: string, action: string, extra: Record<string, unknown> = {}) {
    setB(id, action);
    try {
      const r = await fetch('/api/cron/email-tool/draft/visual-action', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action, ...extra }),
      }).then(x => x.json());
      if (r.error) { setMsg(`${action} failed: ${r.error}`); return null; }
      return r;
    } finally { setB(id, null); }
  }

  async function setSender(d: Draft, senderId: string) {
    const r = await action(d.id, 'set-sender', { sender_account_id: senderId });
    if (r) setDrafts(ds => ds.map(x => x.id === d.id
      ? { ...x, sender_account_id: senderId, sender_name: founders.find(f => f.id === senderId)?.name ?? x.sender_name, subject: r.subject, body: r.body, email_html: r.email_html }
      : x));
  }

  async function saveEdit(d: Draft) {
    const r = await action(d.id, 'edit', { body: draftBody });
    if (r) { setDrafts(ds => ds.map(x => x.id === d.id ? { ...x, body: draftBody, email_html: r.email_html } : x)); setEditing(null); }
  }

  async function removeAfter(id: string, fn: () => Promise<unknown>) {
    const r = await fn();
    if (r) setDrafts(ds => ds.filter(x => x.id !== id));
  }

  async function send(d: Draft) {
    setB(d.id, 'send');
    try {
      const r = await fetch('/api/cron/email-tool/draft/visual-send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      }).then(x => x.json());
      if (r.ok) { setMsg(`✓ Sent to ${d.email} (${r.gmail_message_id ?? ''})`); setDrafts(ds => ds.filter(x => x.id !== d.id)); }
      else if (r.committed) { setMsg(`✓ Queued for ${d.email} — sending shortly`); setDrafts(ds => ds.filter(x => x.id !== d.id)); }
      else setMsg(`Send failed (${d.email}): ${r.last_error ?? r.error ?? r.queue_status} — still ready, try again`);
    } finally { setB(d.id, null); }
  }

  function openImg(d: Draft) { setImgFor(d.id); setImgPrompt(''); setImgCand(null); }
  async function genImg(d: Draft) {
    setImgBusy(true);
    try {
      const r = await fetch('/api/cron/email-tool/draft/visual-image', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: d.id, prompt: imgPrompt }),
      }).then(x => x.json());
      if (r.error) { setMsg(`image gen failed: ${r.error}`); return; }
      setImgCand({ image_url: r.image_url, current_url: r.current_url });
    } finally { setImgBusy(false); }
  }
  async function useImg(d: Draft, url: string) {
    setImgBusy(true);
    try {
      const r = await fetch('/api/cron/email-tool/draft/visual-image-select', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: d.id, image_url: url }),
      }).then(x => x.json());
      if (r.error) { setMsg(`apply failed: ${r.error}`); return; }
      setDrafts(ds => ds.map(x => x.id === d.id ? { ...x, image_url: url, email_html: r.email_html } : x));
      setImgFor(null); setImgCand(null);
      setMsg('✓ image updated on the email + the calproduct page');
    } finally { setImgBusy(false); }
  }

  if (loading) return <div className="text-sm text-gray-500 p-8 text-center">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500">{drafts.length} ready to review · one-button send</p>
          {gen && (
            <span className="text-xs px-2 py-1 rounded-md bg-gray-100 text-gray-700 font-mono">
              {gen.ready}/{gen.target} ready{gen.inflight ? ` · ${gen.inflight} generating` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {gen?.enabled
            ? <button onClick={() => toggleGen('stop')} className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-800 rounded-md text-sm font-medium">⏹ Stop generating</button>
            : <button onClick={() => toggleGen('start')} className="px-3 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-md text-sm font-medium">▶ Start generating</button>}
          <button onClick={() => { load(); loadGen(); }} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md text-sm">Refresh</button>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {(['all', 'A', 'B', 'C'] as const).map(v => {
          const n = v === 'all' ? counts?.total : counts?.[v];
          return (
            <button
              key={v}
              onClick={() => setVariant(v)}
              className={`px-3 py-1 rounded-md text-xs font-medium ${variant === v ? 'bg-black text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            >
              {v === 'all' ? 'All' : v}{n != null ? ` · ${n}` : ''}
              {v !== 'all' && <span className="ml-1 opacity-70 font-normal">{VARIANT_LABEL[v]}</span>}
            </button>
          );
        })}
        <span className="text-xs text-gray-400 ml-1">A/B arms — same image + page, copy differs</span>
      </div>
      {msg && <div className="mb-4 text-sm px-3 py-2 bg-blue-50 text-blue-800 rounded-md flex justify-between"><span>{msg}</span><button onClick={() => setMsg(null)}>✕</button></div>}
      {drafts.length === 0 && <div className="text-sm text-gray-400 p-8 text-center">No ready drafts. Generate some, then refresh.</div>}

      <div className="space-y-5">
        {drafts.map(d => {
          const b = busy[d.id];
          const pageUrl = d.page_slug ? `${pagesBase}/${d.page_slug}` : null;
          return (
            <div key={d.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex gap-4 flex-wrap">
                {/* image */}
                {d.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.image_url} alt="" className="w-44 h-auto rounded-md border border-gray-100 object-cover" />
                )}
                {/* meta + email preview */}
                <div className="flex-1 min-w-[280px]">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold flex items-center gap-2">
                        <span>{d.first_name} · {d.company}</span>
                        {d.variant && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${VARIANT_STYLE[d.variant] ?? 'bg-gray-100 text-gray-600'}`}>{d.variant}</span>}
                      </div>
                      <div className="text-xs text-gray-500">{d.email} · <span className="text-gray-700">{d.industry}</span></div>
                    </div>
                    <select
                      value={d.sender_account_id}
                      onChange={e => setSender(d, e.target.value)}
                      disabled={!!b}
                      className="text-sm border border-gray-200 rounded-md px-2 py-1"
                    >
                      {founders.map(f => <option key={f.id} value={f.id}>{f.name.split(' ')[0]}</option>)}
                    </select>
                  </div>

                  <div className="mt-1 text-xs text-gray-500">Subject: <span className="font-mono">{d.subject}</span></div>

                  {editing === d.id ? (
                    <div className="mt-2">
                      <textarea
                        value={draftBody}
                        onChange={e => setDraftBody(e.target.value)}
                        rows={6}
                        className="w-full text-sm border border-gray-200 rounded-md p-2 font-mono"
                      />
                      <div className="mt-1 flex gap-2">
                        <button onClick={() => saveEdit(d)} disabled={!!b} className="px-3 py-1 bg-green-100 text-green-800 rounded-md text-sm">Save</button>
                        <button onClick={() => setEditing(null)} className="px-3 py-1 bg-gray-100 rounded-md text-sm">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <iframe
                      title={`email-${d.id}`}
                      sandbox=""
                      loading="lazy"
                      srcDoc={d.email_html ?? ''}
                      className="mt-2 w-full h-44 border border-gray-100 rounded-md bg-white"
                    />
                  )}
                </div>
              </div>

              {/* image regenerate panel */}
              {imgFor === d.id && (
                <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
                  <div className="text-sm font-medium">Regenerate image</div>
                  <div className="text-xs text-gray-500 mb-2">Generates a fresh image from your founders photo + your notes. Pick which to use — it updates the email <b>and</b> the calproduct page automatically.</div>
                  <textarea
                    value={imgPrompt}
                    onChange={e => setImgPrompt(e.target.value)}
                    rows={2}
                    placeholder="Optional notes (e.g. 'fix the company spelling', 'keep it upright', 'bigger text')"
                    className="w-full text-sm border border-gray-200 rounded-md p-2"
                  />
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => genImg(d)} disabled={imgBusy} className="px-3 py-1.5 bg-black text-white rounded-md text-sm disabled:opacity-50">{imgBusy ? 'Generating…' : 'Generate'}</button>
                    <button onClick={() => { setImgFor(null); setImgCand(null); }} className="px-3 py-1.5 bg-gray-100 rounded-md text-sm">Close</button>
                  </div>
                  {imgCand && (
                    <div className="mt-3 flex gap-5 flex-wrap">
                      <div className="text-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={imgCand.current_url ?? d.image_url ?? ''} alt="current" className="w-36 rounded-md border border-gray-200" />
                        <div className="text-xs text-gray-500 mt-1">current</div>
                        {(imgCand.current_url ?? d.image_url) && <button onClick={() => useImg(d, (imgCand.current_url ?? d.image_url)!)} disabled={imgBusy} className="mt-1 px-2 py-1 bg-gray-100 rounded text-xs">Keep current</button>}
                      </div>
                      <div className="text-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={imgCand.image_url} alt="new" className="w-36 rounded-md border border-gray-200" />
                        <div className="text-xs text-gray-500 mt-1">new</div>
                        <button onClick={() => useImg(d, imgCand.image_url)} disabled={imgBusy} className="mt-1 px-2 py-1 bg-green-100 text-green-800 rounded text-xs">Use new ✓</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* actions */}
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <button onClick={() => send(d)} disabled={!!b} className="px-4 py-1.5 bg-black text-white rounded-md text-sm font-medium disabled:opacity-50">
                  {b === 'send' ? 'Sending…' : 'Send'}
                </button>
                {editing === d.id ? null : (
                  <button onClick={() => { setEditing(d.id); setDraftBody(d.body ?? ''); }} disabled={!!b} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md text-sm">Edit email</button>
                )}
                <button onClick={() => openImg(d)} disabled={!!b} className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-md text-sm">Regen image</button>
                <button onClick={() => removeAfter(d.id, () => action(d.id, 'regenerate'))} disabled={!!b} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md text-sm">{b === 'regenerate' ? '…' : 'Regenerate'}</button>
                <button onClick={() => removeAfter(d.id, () => action(d.id, 'skip'))} disabled={!!b} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md text-sm text-gray-600">Skip</button>
                {pageUrl && <a href={pageUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-sm text-blue-600 hover:underline ml-auto">Open page ↗</a>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
