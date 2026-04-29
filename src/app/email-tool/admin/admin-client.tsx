'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { TemplatesTab } from './templates-tab';
import { ScheduleTab } from './schedule-tab';
import { PriorityTab } from './priority-tab';
import { OverviewTab } from './overview-tab';
import { PriorityUploadModal } from '@/components/email-tool/priority-upload-modal';

type TabId = 'overview' | 'templates' | 'schedule' | 'priority';

interface Props {
  memberName: string;
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'templates', label: 'Templates' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'priority', label: 'Priority Queue' },
];

interface ScheduleSummary {
  enabled: boolean;
  send_mode: 'production' | 'dry_run' | 'allowlist';
  skip_next_run: boolean;
}

export default function AdminClient({ memberName }: Props) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialTab = (params.get('tab') as TabId) ?? 'overview';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [schedule, setSchedule] = useState<ScheduleSummary | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [scheduleVersion, setScheduleVersion] = useState(0);

  // Keep tab state in sync with URL when user uses back/forward.
  useEffect(() => {
    const t = (params.get('tab') as TabId) ?? 'overview';
    if (t !== tab) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const refreshSchedule = useCallback(async () => {
    const res = await fetch('/api/cron/email-tool/schedule');
    if (res.ok) {
      const data = await res.json();
      setSchedule({
        enabled: data.schedule?.enabled ?? false,
        send_mode: data.schedule?.send_mode ?? 'production',
        skip_next_run: data.schedule?.skip_next_run ?? false,
      });
    }
  }, []);

  useEffect(() => { refreshSchedule(); }, [refreshSchedule, scheduleVersion]);

  function navigate(t: TabId) {
    setTab(t);
    const sp = new URLSearchParams(params);
    sp.set('tab', t);
    router.push(`${pathname}?${sp.toString()}`);
  }

  async function pauseAll() {
    if (!window.confirm('Pause all founders\' email sends? Active campaigns will stop draining. This requires explicit Resume to restart.')) return;
    const res = await fetch('/api/cron/email-tool/pause-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.alert(d.error ?? 'pause failed');
      return;
    }
    window.alert('All founders paused. Click "Resume All" in Overview tab to resume.');
    setScheduleVersion(v => v + 1);
  }

  async function skipNextRun() {
    if (!window.confirm('Skip the next scheduled campaign?')) return;
    const res = await fetch('/api/cron/email-tool/skip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skip: true }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.alert(d.error ?? 'skip failed');
      return;
    }
    setScheduleVersion(v => v + 1);
  }

  // Status badge
  const badge = (() => {
    if (!schedule) return { text: 'loading', color: 'text-gray-500' };
    if (!schedule.enabled) return { text: 'DISABLED', color: 'text-gray-700' };
    if (schedule.skip_next_run) return { text: 'SKIP NEXT', color: 'text-orange-700' };
    if (schedule.send_mode !== 'production') return { text: `${schedule.send_mode.toUpperCase()}`, color: 'text-yellow-700' };
    return { text: 'ENABLED', color: 'text-green-700' };
  })();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">Cold Outreach Automation</h1>
              <p className="text-sm text-gray-500 mt-1">Signed in as {memberName}</p>
            </div>
            <div className="text-sm">
              <span className="text-gray-500">schedule: </span>
              <span className={`font-medium ${badge.color}`}>{badge.text}</span>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={pauseAll}
              className="px-3 py-2 bg-red-100 hover:bg-red-200 text-red-800 rounded-md text-sm font-medium"
            >
              Pause All Sending
            </button>
            <button
              onClick={skipNextRun}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-sm font-medium"
            >
              Skip Next Run
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="px-3 py-2 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-md text-sm font-medium"
            >
              Upload Priority Batch
            </button>
          </div>
        </header>

        <nav className="border-b border-gray-200 mb-6">
          <div className="flex gap-1">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => navigate(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        <main>
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'overview' && <OverviewTab />}
          {tab === 'schedule' && <ScheduleTab />}
          {tab === 'priority' && <PriorityTab />}
        </main>
      </div>

      {showUpload && (
        <PriorityUploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); setScheduleVersion(v => v + 1); }}
        />
      )}
    </div>
  );
}
