'use client';

import { useEffect, useState, useCallback } from 'react';

interface ScheduleRow {
  id: 1;
  enabled: boolean;
  send_mode: 'production' | 'dry_run' | 'allowlist';
  warmup_started_on: string | null;
  warmup_day_completed: number;
  skip_next_run: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  crashes_counter_reset_at: string | null;
}

interface CampaignRow {
  id: string;
  scheduled_for: string;
  status: 'pending' | 'running' | 'done' | 'aborted' | 'paused' | 'exhausted' | 'skipped';
  total_picked: number;
  total_sent: number;
  total_failed: number;
  total_skipped: number;
  abort_reason: string | null;
  warmup_day: number | null;
  send_mode: 'production' | 'dry_run' | 'allowlist';
  started_at: string | null;
  completed_at: string | null;
}

const STATUS_COLORS: Record<CampaignRow['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  running: 'bg-blue-100 text-blue-800',
  done: 'bg-green-100 text-green-800',
  aborted: 'bg-red-100 text-red-800',
  paused: 'bg-orange-100 text-orange-800',
  exhausted: 'bg-gray-100 text-gray-700',
  skipped: 'bg-gray-50 text-gray-500',
};

const WEEKDAY_GRID = [
  { day: 'Monday', time: '5:00 AM PT' },
  { day: 'Tuesday', time: '5:30 AM PT' },
  { day: 'Wednesday', time: '6:00 AM PT' },
  { day: 'Thursday', time: '6:30 AM PT' },
  { day: 'Friday', time: '7:00 AM PT' },
  { day: 'Saturday', time: '— no campaign —' },
  { day: 'Sunday', time: '— no campaign —' },
];

export function ScheduleTab() {
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null);
  const [recentRuns, setRecentRuns] = useState<CampaignRow[]>([]);
  const [cleanupCounts, setCleanupCounts] = useState<{ dryrun: number; allowlist: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [schedRes, runsRes, cleanupRes] = await Promise.all([
        fetch('/api/cron/email-tool/schedule').then(r => r.json()),
        fetch('/api/cron/email-tool/campaigns?limit=10').then(r => r.json()).catch(() => ({ campaigns: [] })),
        fetch('/api/cron/email-tool/cleanup-test-blacklist').then(r => r.json()),
      ]);
      setSchedule(schedRes.schedule ?? null);
      setRecentRuns(runsRes.campaigns ?? []);
      setCleanupCounts({
        dryrun: cleanupRes.dryrun_count ?? 0,
        allowlist: cleanupRes.allowlist_count ?? 0,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patchSchedule(updates: Partial<Pick<ScheduleRow, 'enabled' | 'send_mode'>>) {
    const res = await fetch('/api/cron/email-tool/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error ?? 'update failed');
      return;
    }
    load();
  }

  async function retryToday() {
    if (!window.confirm('Retry today\'s aborted campaign?')) return;
    const res = await fetch('/api/cron/email-tool/retry-today', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error ?? 'retry failed');
      return;
    }
    load();
  }

  async function cleanupTestBlacklist() {
    if (!cleanupCounts) return;
    const total = cleanupCounts.dryrun + cleanupCounts.allowlist;
    if (total === 0) {
      window.alert('No test-mode blacklist entries to clean up.');
      return;
    }
    if (!window.confirm(`Delete ${total} test-mode blacklist rows (${cleanupCounts.dryrun} dryrun + ${cleanupCounts.allowlist} allowlist)? Production rows (source IS NULL) will NOT be touched.`)) {
      return;
    }
    const res = await fetch('/api/cron/email-tool/cleanup-test-blacklist', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error ?? 'cleanup failed');
      return;
    }
    const data = await res.json();
    window.alert(`Deleted ${data.deleted_dryrun} dryrun + ${data.deleted_allowlist} allowlist rows.`);
    load();
  }

  if (loading) return <div className="text-sm text-gray-500 p-8 text-center">Loading...</div>;
  if (error) return <div className="text-sm text-red-600 p-8 text-center">Error: {error}</div>;
  if (!schedule) return <div className="text-sm text-red-600 p-8 text-center">Schedule row missing.</div>;

  // Today's aborted campaign? (For Retry button)
  const today = new Date().toISOString().split('T')[0];
  const todayAborted = recentRuns.find(c => c.scheduled_for.startsWith(today) && c.status === 'aborted');

  return (
    <div className="space-y-6">
      {/* Master controls */}
      <section className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-lg font-semibold mb-3">Master Controls</h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <label className="block">
            <span className="text-sm font-medium">Schedule enabled</span>
            <select
              value={schedule.enabled ? 'true' : 'false'}
              onChange={e => patchSchedule({ enabled: e.target.value === 'true' })}
              className="mt-1 block w-full border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium">Send mode</span>
            <select
              value={schedule.send_mode}
              onChange={e => patchSchedule({ send_mode: e.target.value as ScheduleRow['send_mode'] })}
              className="mt-1 block w-full border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="production">production (real Gmail send)</option>
              <option value="dry_run">dry_run (no Gmail call, synthetic IDs)</option>
              <option value="allowlist">allowlist (real send to env-list only)</option>
            </select>
          </label>
        </div>

        {schedule.send_mode !== 'production' && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-2 text-xs text-yellow-800 mb-3">
            Send mode is <code>{schedule.send_mode}</code> — real recipients will NOT receive emails.
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Last run:</span>{' '}
            <span className="font-mono">
              {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString() : 'never'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Next run:</span>{' '}
            <span className="font-mono">
              {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : '—'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Warmup day:</span>{' '}
            <span className="font-mono">
              {schedule.warmup_started_on
                ? `${schedule.warmup_day_completed} (started ${schedule.warmup_started_on})`
                : '—'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Skip next run:</span>{' '}
            <span className="font-mono">{schedule.skip_next_run ? 'YES' : 'no'}</span>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={retryToday}
            disabled={!todayAborted}
            className="px-3 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100 disabled:text-gray-400"
            title={todayAborted ? 'Retry today\'s aborted campaign' : 'Only enabled when today\'s campaign is aborted'}
          >
            Retry today&apos;s run
          </button>
        </div>
      </section>

      {/* Weekday grid */}
      <section className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-lg font-semibold mb-3">Weekly Schedule (read-only)</h2>
        <table className="w-full text-sm">
          <tbody>
            {WEEKDAY_GRID.map(({ day, time }) => (
              <tr key={day} className="border-b border-gray-100 last:border-0">
                <td className="py-2 text-gray-600 w-32">{day}</td>
                <td className="py-2 font-mono">{time}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-500 mt-3">
          Times are baked into the code (<code>WEEKDAY_START_TIMES_PT</code>). Changing them requires a code commit.
        </p>
      </section>

      {/* Recent runs */}
      <section className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-lg font-semibold mb-3">Recent Runs</h2>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No campaigns yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 text-xs">
                <th className="py-1">Scheduled</th>
                <th className="py-1">Status</th>
                <th className="py-1">Mode</th>
                <th className="py-1 text-right">Picked</th>
                <th className="py-1 text-right">Sent</th>
                <th className="py-1 text-right">Failed</th>
                <th className="py-1 text-right">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map(c => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="py-1 font-mono text-xs">{new Date(c.scheduled_for).toLocaleString()}</td>
                  <td className="py-1">
                    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[c.status]}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="py-1 text-xs">{c.send_mode}</td>
                  <td className="py-1 text-right">{c.total_picked}</td>
                  <td className="py-1 text-right text-green-700">{c.total_sent}</td>
                  <td className="py-1 text-right text-red-700">{c.total_failed}</td>
                  <td className="py-1 text-right text-gray-500">{c.total_skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Test-mode cleanup */}
      <section className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-lg font-semibold mb-2">Test-mode Blacklist Cleanup</h2>
        <p className="text-xs text-gray-500 mb-3">
          Removes blacklist rows tagged <code>source=&apos;dryrun:*&apos;</code> or <code>&apos;allowlist:*&apos;</code>.
          Production rows (<code>source IS NULL</code>) are never touched.
        </p>
        {cleanupCounts && (
          <div className="text-sm mb-3">
            <span className="text-gray-500">Tagged rows:</span>{' '}
            <span className="font-mono">
              {cleanupCounts.dryrun} dryrun + {cleanupCounts.allowlist} allowlist
            </span>
          </div>
        )}
        <button
          onClick={cleanupTestBlacklist}
          disabled={!cleanupCounts || (cleanupCounts.dryrun + cleanupCounts.allowlist === 0)}
          className="px-3 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100 disabled:text-gray-400"
        >
          Clean up test-mode blacklist
        </button>
      </section>

      {/* Pre-go-live checklist (placeholder for PR 5) */}
      <section className="border border-yellow-200 bg-yellow-50 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Pre-Go-Live Checklist</h2>
        <p className="text-sm text-yellow-900">
          Wired in PR 5 — will show the live status of each go-live blocker (Vercel Pro tier,
          variants per founder, plus-aliasing filters, OAuth tokens, dry-run + allowlist runs).
        </p>
      </section>
    </div>
  );
}
