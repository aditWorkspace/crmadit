'use client';

// Terminal-style live log for the /enrich-upload streaming route.
// Opens when the user picks a CSV in the "Enrich + upload (admin)"
// section on /email-tool. Renders per-row events as colored log lines
// and shows running counts + cost estimate. Auto-scroll until user
// scrolls up.

import { useEffect, useRef, useState } from 'react';

interface Props {
  file: File;
  mode: 'pool_top' | 'pool_bottom';
  onClose: () => void;
  onComplete: () => void;
}

interface LineEntry {
  text: string;
  tone: 'cyan' | 'green' | 'yellow' | 'magenta' | 'red' | 'gray' | 'white';
}

const TONE_CLASS: Record<LineEntry['tone'], string> = {
  cyan: 'text-cyan-300',
  green: 'text-emerald-300',
  yellow: 'text-amber-300',
  magenta: 'text-fuchsia-300',
  red: 'text-red-400',
  gray: 'text-gray-500',
  white: 'text-gray-100',
};

interface DoneSummary {
  total: number;
  kept: number;
  dropped: number;
  bec_calls: number;
  icypeas_calls: number;
  cost_usd: number;
  inserted: number;
  already_in_pool: number;
  already_blacklisted: number;
  mode: string;
  pool_pointer: number | null;
}

export function EnrichUploadModal({ file, mode, onClose, onComplete }: Props) {
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [stats, setStats] = useState({
    total: 0, processed: 0, kept: 0, dropped: 0,
    bec_calls: 0, icypeas_calls: 0, cost_usd: 0,
  });
  const [done, setDone] = useState<DoneSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const push = (text: string, tone: LineEntry['tone']) =>
    setLines(prev => [...prev, { text, tone }]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);

      let res: Response;
      try {
        res = await fetch('/api/cron/email-tool/enrich-upload', {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        setError(`network error: ${(err as Error).message}`);
        return;
      }
      if (!res.ok || !res.body) {
        let detail = `http ${res.status}`;
        try { detail = (await res.json()).error ?? detail; } catch {}
        setError(detail);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // Loop reading SSE chunks. Events are separated by \n\n; each
      // event is a single JSON object.
      while (!cancelled) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!raw) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(raw);
          } catch {
            push(`! parse fail: ${raw.slice(0, 80)}`, 'red');
            continue;
          }
          handleEvent(ev);
        }
      }
    })();

    function handleEvent(ev: Record<string, unknown>) {
      const t = ev.type as string;
      if (t === 'start') {
        const total = Number(ev.total ?? 0);
        setStats(s => ({ ...s, total }));
        push(`> starting enrich of ${total} rows · mode=${ev.mode}`, 'white');
      } else if (t === 'row') {
        const i = Number(ev.i ?? -1);
        const stage = ev.stage as string;
        if (stage === 'parse') {
          push(`row ${i + 1}  parse  ${(ev.first_name as string) || '?'} @ ${(ev.company as string) || '?'}${ev.domain ? ` (${ev.domain})` : ''}`, 'gray');
        } else if (stage === 'given_email') {
          push(`row ${i + 1}  given email  ${ev.email as string}`, 'cyan');
        } else if (stage === 'guess') {
          push(`row ${i + 1}  guessing  ${ev.email as string}`, 'cyan');
        } else if (stage === 'bec_check') {
          const outcome = ev.outcome as string;
          if (outcome === 'passed') {
            push(`row ${i + 1}  bec ✓ passed  ${ev.email as string}  (credits=${ev.credits_left})`, 'green');
            setStats(s => ({ ...s, bec_calls: s.bec_calls + 1, cost_usd: s.cost_usd + 0.001 }));
          } else if (outcome === 'failed') {
            push(`row ${i + 1}  bec ✗ failed (${ev.event_name as string}) → falling back to icypeas`, 'yellow');
            setStats(s => ({ ...s, bec_calls: s.bec_calls + 1, cost_usd: s.cost_usd + 0.001 }));
          } else if (outcome === 'unknown') {
            push(`row ${i + 1}  bec ? unknown (${ev.event_name as string}) → falling back to icypeas`, 'yellow');
            setStats(s => ({ ...s, bec_calls: s.bec_calls + 1 }));
          } else {
            push(`row ${i + 1}  bec err: ${(ev.error as string) || (ev.event_name as string)} → falling back`, 'yellow');
          }
        } else if (stage === 'icypeas_submit') {
          push(`row ${i + 1}  icypeas → searching for ${ev.first_name} ${ev.last_name ?? ''} @ ${ev.domain_or_company}`, 'magenta');
        } else if (stage === 'icypeas_result') {
          const status = ev.status as string;
          const email = ev.email as string | null;
          if (email) {
            push(`row ${i + 1}  icypeas ✓ ${status}  ${email}`, 'magenta');
            setStats(s => ({ ...s, icypeas_calls: s.icypeas_calls + 1, cost_usd: s.cost_usd + 0.01 }));
          } else {
            push(`row ${i + 1}  icypeas ${status}  no email`, 'red');
            setStats(s => ({ ...s, icypeas_calls: s.icypeas_calls + 1 }));
          }
        } else if (stage === 'kept') {
          push(`row ${i + 1}  kept  ${ev.email as string}`, 'green');
          setStats(s => ({ ...s, processed: i + 1, kept: s.kept + 1 }));
        } else if (stage === 'dropped') {
          push(`row ${i + 1}  dropped  reason=${ev.reason}`, 'red');
          setStats(s => ({ ...s, processed: i + 1, dropped: s.dropped + 1 }));
        }
      } else if (t === 'batch') {
        const stage = ev.stage as string;
        if (stage === 'pool_lookup') {
          push(`> checking which of the ${ev.kept_count} kept rows are already in pool / blacklist…`, 'white');
        } else if (stage === 'pool_dedupe') {
          push(`> dedupe: ${ev.already_in_pool} already in pool, ${ev.already_blacklisted} blacklisted, ${ev.will_insert} to insert`, 'white');
        } else if (stage === 'pool_insert_progress') {
          push(`> inserted ${ev.inserted}/${ev.total} into email_pool`, 'gray');
        }
      } else if (t === 'done') {
        const d = ev as unknown as DoneSummary;
        setDone(d);
        push(`> done · kept=${d.kept} dropped=${d.dropped} inserted=${d.inserted} (pool ${d.mode === 'pool_top' ? 'TOP' : 'BOTTOM'}) · est cost $${d.cost_usd.toFixed(3)}`, 'white');
      } else if (t === 'error') {
        push(`! error: ${ev.detail ?? ev.stage ?? 'unknown'}`, 'red');
      }
    }

    return () => { cancelled = true; };
  }, [file, mode]);

  // Auto-scroll the log to the bottom when new lines arrive (unless
  // the user has scrolled up — checked by comparing scrollTop to the
  // max scroll position before each append).
  useEffect(() => {
    if (!autoscroll || !logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [lines, autoscroll]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-white">Enrich + upload</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {file.name} · {stats.total > 0 ? `row ${stats.processed}/${stats.total}` : 'starting…'} ·
              est cost <span className="font-mono text-emerald-300">${stats.cost_usd.toFixed(3)}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xs">
            {done ? 'close' : 'cancel'}
          </button>
        </header>
        <div
          ref={logBoxRef}
          onScroll={() => {
            const el = logBoxRef.current;
            if (!el) return;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setAutoscroll(atBottom);
          }}
          className="flex-1 overflow-y-auto bg-black font-mono text-[11px] p-3 leading-snug"
          style={{ minHeight: '300px' }}
        >
          {lines.length === 0 && (
            <div className="text-gray-500">$ uploading {file.name}…</div>
          )}
          {lines.map((l, idx) => (
            <div key={idx} className={`${TONE_CLASS[l.tone]} whitespace-pre-wrap`}>
              {l.text}
            </div>
          ))}
          {error && (
            <div className="text-red-400 mt-2">! aborted: {error}</div>
          )}
        </div>
        <footer className="px-4 py-2.5 border-t border-gray-700 flex items-center justify-between text-xs">
          <div className="flex gap-3 font-mono">
            <span className="text-emerald-300">kept {stats.kept}</span>
            <span className="text-red-400">dropped {stats.dropped}</span>
            <span className="text-cyan-300">bec {stats.bec_calls}</span>
            <span className="text-fuchsia-300">icy {stats.icypeas_calls}</span>
          </div>
          <div className="flex items-center gap-2">
            {!autoscroll && (
              <button
                onClick={() => { setAutoscroll(true); }}
                className="text-amber-300 hover:text-amber-100"
                title="scroll to bottom"
              >
                ↓ follow
              </button>
            )}
            {done && (
              <button
                onClick={() => { onComplete(); onClose(); }}
                className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
