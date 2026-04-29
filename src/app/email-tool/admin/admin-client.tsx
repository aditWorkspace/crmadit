'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { TemplatesTab } from './templates-tab';

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

export default function AdminClient({ memberName }: Props) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialTab = (params.get('tab') as TabId) ?? 'templates';
  const [tab, setTab] = useState<TabId>(initialTab);

  // Keep tab state in sync with URL when user uses back/forward
  useEffect(() => {
    const t = (params.get('tab') as TabId) ?? 'templates';
    if (t !== tab) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [params]);

  function navigate(t: TabId) {
    setTab(t);
    const sp = new URLSearchParams(params);
    sp.set('tab', t);
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">Cold Outreach Automation</h1>
              <p className="text-sm text-gray-500 mt-1">Signed in as {memberName}</p>
            </div>
            <div className="text-sm text-gray-500">
              schedule: <span className="font-mono">enabled = false</span>
            </div>
          </div>

          {/* Header action buttons. Wired up in PR 4 & 5; placeholders for PR 2. */}
          <div className="mt-4 flex gap-2">
            <button
              disabled
              className="px-3 py-2 bg-red-100 text-red-400 rounded-md text-sm font-medium cursor-not-allowed"
              title="Wired in PR 5"
            >
              🛑 Pause All Sending
            </button>
            <button
              disabled
              className="px-3 py-2 bg-gray-100 text-gray-400 rounded-md text-sm font-medium cursor-not-allowed"
              title="Wired in PR 4"
            >
              ⏭ Skip Next Run
            </button>
            <button
              disabled
              className="px-3 py-2 bg-blue-100 text-blue-400 rounded-md text-sm font-medium cursor-not-allowed"
              title="Wired in PR 4"
            >
              ➕ Upload Priority Batch
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
                  tab === t.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        <main>
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'overview' && (
            <div className="text-sm text-gray-500 italic p-8 text-center bg-white rounded-md border border-gray-200">
              Overview tab is built in PR 5 (health dashboard, per-founder cards, pool runway).
            </div>
          )}
          {tab === 'schedule' && (
            <div className="text-sm text-gray-500 italic p-8 text-center bg-white rounded-md border border-gray-200">
              Schedule tab is built in PR 4 (master toggle, weekday grid, recent runs).
            </div>
          )}
          {tab === 'priority' && (
            <div className="text-sm text-gray-500 italic p-8 text-center bg-white rounded-md border border-gray-200">
              Priority Queue tab is built in PR 4 (CSV upload, batch list, cancellation).
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
