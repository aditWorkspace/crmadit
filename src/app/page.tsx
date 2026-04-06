'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@/hooks/use-session';
import { ActionItem, FollowUp, ActivityLog, TeamMember } from '@/types';
import { MyActionItems } from '@/components/dashboard/my-action-items';
import { PendingFollowups } from '@/components/dashboard/pending-followups';
import { PipelineOverview } from '@/components/dashboard/pipeline-overview';
import { SpeedScorecard } from '@/components/dashboard/speed-scorecard';
import { StaleAlertBanner } from '@/components/dashboard/stale-alert-banner';
import { ActivityFeed } from '@/components/dashboard/activity-feed';

interface DashboardData {
  action_items: ActionItem[];
  follow_ups: FollowUp[];
  recent_activity: ActivityLog[];
  stage_counts: Record<string, number>;
  total_active: number;
  stale_count: number;
  speed_by_member: Record<string, { avg_reply: number | null; avg_demo: number | null; active_count: number }>;
  team_members: TeamMember[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{title}</h2>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const { user, isLoading } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!user) return;
    const res = await fetch('/api/dashboard', {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      setData(await res.json());
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const removeActionItem = (id: string) => {
    setData(d => d ? { ...d, action_items: d.action_items.filter(i => i.id !== id) } : d);
  };

  const removeFollowUp = (id: string) => {
    setData(d => d ? { ...d, follow_ups: d.follow_ups.filter(f => f.id !== id) } : d);
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  if (isLoading || loading) {
    return (
      <div className="p-8 space-y-4">
        <div className="h-7 w-48 bg-gray-100 rounded animate-pulse" />
        <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">
          Good {greeting}, {user?.name}
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Here&apos;s what needs your attention.</p>
      </div>

      {data?.stale_count ? <StaleAlertBanner staleCount={data.stale_count} /> : null}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[60%_1fr] gap-8">
        {/* Left column */}
        <div className="space-y-8">
          <Section title="My Action Items">
            <MyActionItems
              items={data?.action_items || []}
              onComplete={removeActionItem}
            />
          </Section>

          <Section title="Pending Follow-ups">
            <PendingFollowups
              followUps={data?.follow_ups || []}
              onUpdate={removeFollowUp}
            />
          </Section>

          <Section title="Recent Activity">
            <ActivityFeed activities={data?.recent_activity || []} />
          </Section>
        </div>

        {/* Right column */}
        <div className="space-y-8">
          <Section title="Pipeline">
            <PipelineOverview
              stageCounts={data?.stage_counts || {}}
              totalActive={data?.total_active || 0}
            />
          </Section>

          <Section title="Speed Scorecard">
            <SpeedScorecard
              members={data?.team_members || []}
              speedByMember={data?.speed_by_member || {}}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}
