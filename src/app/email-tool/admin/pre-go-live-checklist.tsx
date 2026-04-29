'use client';

import { useEffect, useState, useCallback } from 'react';

interface CheckResult {
  id: string;
  label: string;
  required: boolean;
  status: 'ok' | 'fail';
  detail?: string;
}

// Manual self-attestation items — admin checks these off themselves.
// Persisted to localStorage so the page survives reloads.
const MANUAL_CHECKS: Array<{ id: string; label: string; required: boolean }> = [
  { id: 'vercel_pro', label: 'Vercel project is on Pro tier (cron supports * * * * *)', required: true },
  { id: 'plus_aliasing', label: 'Each founder set up Gmail plus-aliasing filter for +unsubscribe', required: true },
  { id: 'cron_registered', label: 'Vercel dashboard shows /api/cron/email-tool/tick firing every minute', required: true },
  { id: 'sentry', label: 'Sentry / external error tracking integrated (non-blocking)', required: false },
];

const LOCAL_STORAGE_KEY = 'email-tool-pre-go-live-manual';

function loadManual(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveManual(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
}

export function PreGoLiveChecklist() {
  const [auto, setAuto] = useState<CheckResult[]>([]);
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await fetch('/api/cron/email-tool/pre-go-live').then(r => r.json())) as { checks?: CheckResult[]; error?: string };
      if (r.error) {
        setError(r.error);
      } else {
        setAuto(r.checks ?? []);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
    setManual(loadManual());
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleManual(id: string) {
    setManual(prev => {
      const next = { ...prev, [id]: !prev[id] };
      saveManual(next);
      return next;
    });
  }

  // Compute "all required green"
  const requiredAuto = auto.filter(c => c.required);
  const requiredAutoOK = requiredAuto.every(c => c.status === 'ok');
  const requiredManual = MANUAL_CHECKS.filter(c => c.required);
  const requiredManualOK = requiredManual.every(c => manual[c.id] === true);
  const allReadyToGoLive = requiredAutoOK && requiredManualOK;

  if (loading) return <div className="text-sm text-gray-500 p-8 text-center">Loading checklist…</div>;

  return (
    <section className={`border rounded-lg p-4 ${allReadyToGoLive ? 'border-green-200 bg-green-50' : 'border-yellow-200 bg-yellow-50'}`}>
      <h2 className="text-lg font-semibold mb-3">
        Pre-Go-Live Checklist
        {allReadyToGoLive && <span className="ml-2 text-sm text-green-700">✓ all required checks pass</span>}
      </h2>

      {error && (
        <div className="text-red-600 text-sm mb-3 bg-red-50 border border-red-200 rounded p-2">
          Error: {error}
        </div>
      )}

      <div className="space-y-2 mb-4">
        <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Automated checks</h3>
        {auto.map(c => (
          <div key={c.id} className="flex items-start gap-2 text-sm">
            <span className="shrink-0 mt-0.5">
              {c.status === 'ok' ? '✅' : c.required ? '🛑' : '⬜'}
            </span>
            <div className="flex-1 min-w-0">
              <div className={c.required && c.status !== 'ok' ? 'text-red-700' : ''}>
                {c.label}
                {!c.required && <span className="text-gray-500 text-xs ml-1">(non-blocking)</span>}
              </div>
              {c.detail && (
                <div className="text-xs text-gray-500 mt-0.5">{c.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Manual self-attest</h3>
        {MANUAL_CHECKS.map(c => (
          <label key={c.id} className="flex items-start gap-2 text-sm cursor-pointer hover:bg-yellow-100 rounded px-1 py-0.5">
            <input
              type="checkbox"
              checked={manual[c.id] === true}
              onChange={() => toggleManual(c.id)}
              className="mt-0.5"
            />
            <span className={c.required && manual[c.id] !== true ? 'text-yellow-900' : 'text-gray-700'}>
              {c.label}
              {!c.required && <span className="text-gray-500 text-xs ml-1">(non-blocking)</span>}
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-yellow-200 text-sm">
        {allReadyToGoLive ? (
          <p className="text-green-800">
            ✓ All required checks pass. Flip <code>Schedule enabled</code> in Master Controls when ready.
          </p>
        ) : (
          <p className="text-yellow-900">
            Resolve the items marked 🛑 / unchecked above before enabling the schedule.
            Manual self-attest items live in your browser only — your teammates won&apos;t see your checks.
          </p>
        )}
      </div>
    </section>
  );
}
