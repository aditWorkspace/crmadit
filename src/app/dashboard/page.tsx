'use client';

import { useState, useEffect } from 'react';
import { useSession } from '@/hooks/use-session';
import { StaleAlertBanner } from '@/components/dashboard/stale-alert-banner';
import { MyActionItems } from '@/components/dashboard/my-action-items';
import { PendingFollowups } from '@/components/dashboard/pending-followups';
import { HotLeads } from '@/components/dashboard/hot-leads';
import { SpeedScorecard } from '@/components/dashboard/speed-scorecard';
import { VelocityLeaderboard } from '@/components/dashboard/velocity-leaderboard';
import { PipelineOverview } from '@/components/dashboard/pipeline-overview';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { Loader2, LayoutDashboard } from 'lucide-react';

interface DashboardData {
  action_items: unknown[];
  follow_ups: unknown[];
  recent_activity: unknown[];
  stage_counts: Record<string, number>;
  total_active: number;
  stale_count: number;
  speed_by_member: Record<string, { avg_reply: number | null; avg_demo: number | null; active_count: number }>;
  team_members: { id: string; name: string; gmail_connected: boolean; email: string; created_at: string }[];
  velocity_leaderboard: { id: string; name: string; advances: number }[];
  hot_leads: unknown[];
}

export default function DashboardPage() {
  const { user } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = async () => {
    if (!user) return;
    const res = await fetch('/api/dashboard', {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      setData(await res.json());
    }
    setLoading(false);
  };

  useEffect(() => { fetchDashboard(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFollowUpUpdate = () => fetchDashboard();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading dashboard...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        Failed to load dashboard.
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <LayoutDashboard className="h-5 w-5 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
      </div>

      <StaleAlertBanner staleCount={data.stale_count} />

      {/* Top row: pipeline overview */}
      <PipelineOverview stageCounts={data.stage_counts} totalActive={data.total_active} />

      {/* Main grid: action items + hot leads + follow-ups */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Action Items */}
        <div className="lg:col-span-1">
          <div className="rounded-lg border border-gray-100 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">My Action Items</h2>
            <MyActionItems items={data.action_items as never} onComplete={fetchDashboard} />
          </div>
        </div>

        {/* Center: Hot Leads */}
        <div className="lg:col-span-1">
          <div className="rounded-lg border border-gray-100 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
              <span className="text-red-500">Hot Leads</span>
            </h2>
            <HotLeads leads={data.hot_leads as never} />
          </div>
        </div>

        {/* Right: Pending Follow-ups */}
        <div className="lg:col-span-1">
          <div className="rounded-lg border border-gray-100 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Pending Follow-ups</h2>
            <PendingFollowups followUps={data.follow_ups as never} onUpdate={handleFollowUpUpdate} />
          </div>
        </div>
      </div>

      {/* Bottom row: speed + velocity + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-lg border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Response Speed</h2>
          <SpeedScorecard members={data.team_members} speedByMember={data.speed_by_member} />
        </div>
        <div className="rounded-lg border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">7-Day Velocity</h2>
          <VelocityLeaderboard leaderboard={data.velocity_leaderboard} />
        </div>
        <div className="rounded-lg border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Recent Activity</h2>
          <ActivityFeed activities={data.recent_activity as never} />
        </div>
      </div>
    </div>
  );
}
