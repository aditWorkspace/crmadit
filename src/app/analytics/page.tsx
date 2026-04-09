'use client';

import { useEffect, useState, useCallback } from 'react';
import { FunnelChart } from '@/components/analytics/funnel-chart';
import { SpeedChart } from '@/components/analytics/speed-chart';
import { ActivityChart } from '@/components/analytics/activity-chart';
import { SourceChart } from '@/components/analytics/source-chart';
import { TimeToDemoChart } from '@/components/analytics/time-to-demo-chart';
import { WeeklyRetro } from '@/components/analytics/weekly-retro';
import { VelocityChart } from '@/components/analytics/velocity-chart';
import { SpeedScorecard } from '@/components/dashboard/speed-scorecard';
import { VelocityLeaderboard } from '@/components/dashboard/velocity-leaderboard';
import { useSession } from '@/hooks/use-session';
import { TeamMember } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FunnelRow {
  stage: string;
  label: string;
  count: number;
  conversion_rate: number | null;
}

interface SpeedPayload {
  weeks: string[];
  series: { name: string; data: (number | null)[] }[];
}

interface ActivityPayload {
  weeks: string[];
  series: { type: string; data: number[] }[];
}

interface MemberScore {
  name: string;
  avg_stage_score: number;
  lead_count: number;
}

interface BucketRow {
  label: string;
  count: number;
}

interface RetroApiPayload {
  leads_moved_forward: { contact_name: string; company_name: string; from_stage: string; to_stage: string }[];
  new_leads: { contact_name: string; company_name: string }[];
  stale_leads: { contact_name: string; company_name: string; stage: string; hours_stale: number }[];
  total_active: number;
}

interface SpeedData {
  avg_reply: number | null;
  avg_demo: number | null;
  active_count: number;
}

interface VelocityRow {
  stage: string;
  label: string;
  avg_days: number | null;
  sample_count: number;
}

interface DropoffRow {
  from_stage: string;
  from_label: string;
  to_label: string;
  from_count: number;
  to_count: number;
  drop_rate: number;
}

interface VelocityEntry {
  id: string;
  name: string;
  advances: number;
}

interface RetroData extends RetroApiPayload {
  speed_trend: 'faster' | 'slower' | 'same' | 'no_data';
  avg_response_this_week: number | null;
  avg_response_last_week: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeaders(teamMemberId: string): Record<string, string> {
  return { 'x-team-member-id': teamMemberId };
}

const DEMO_BUCKETS = [
  { label: '0-1d', min: 0, max: 1 },
  { label: '1-3d', min: 1, max: 3 },
  { label: '3-7d', min: 3, max: 7 },
  { label: '7-14d', min: 7, max: 14 },
  { label: '14-30d', min: 14, max: 30 },
  { label: '30d+', min: 30, max: Infinity },
];

async function fetchTimeToDemoData(memberId: string): Promise<BucketRow[]> {
  // Use the leads API with a high limit to get all leads for histogram
  const res = await fetch('/api/leads?limit=500&sort_by=demo_sent_at', {
    headers: authHeaders(memberId),
  });
  if (!res.ok) return DEMO_BUCKETS.map((b) => ({ label: b.label, count: 0 }));

  const body = await res.json();
  const leads: { first_reply_at: string | null; demo_sent_at: string | null }[] =
    body.leads ?? [];

  const counts = DEMO_BUCKETS.map((b) => ({ label: b.label, count: 0 }));

  for (const lead of leads) {
    if (!lead.first_reply_at || !lead.demo_sent_at) continue;
    const days =
      (new Date(lead.demo_sent_at).getTime() - new Date(lead.first_reply_at).getTime()) /
      86_400_000;
    if (days < 0) continue;
    const idx = DEMO_BUCKETS.findIndex((b) => days >= b.min && days < b.max);
    if (idx >= 0) counts[idx].count++;
  }

  return counts;
}

function deriveSpeedTrend(
  speedPayload: SpeedPayload | null
): Pick<RetroData, 'speed_trend' | 'avg_response_this_week' | 'avg_response_last_week'> {
  if (!speedPayload || speedPayload.weeks.length < 2) {
    return { speed_trend: 'no_data', avg_response_this_week: null, avg_response_last_week: null };
  }

  const lastIdx = speedPayload.weeks.length - 1;
  const prevIdx = speedPayload.weeks.length - 2;

  const getAvg = (idx: number): number | null => {
    const vals = speedPayload.series
      .map((s) => s.data[idx])
      .filter((v): v is number => v !== null && v !== undefined);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const thisWeek = getAvg(lastIdx);
  const lastWeek = getAvg(prevIdx);

  let trend: RetroData['speed_trend'] = 'no_data';
  if (thisWeek !== null && lastWeek !== null) {
    if (thisWeek < lastWeek * 0.95) trend = 'faster';
    else if (thisWeek > lastWeek * 1.05) trend = 'slower';
    else trend = 'same';
  }

  return {
    speed_trend: trend,
    avg_response_this_week: thisWeek !== null ? Math.round(thisWeek * 10) / 10 : null,
    avg_response_last_week: lastWeek !== null ? Math.round(lastWeek * 10) / 10 : null,
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { user } = useSession();

  const [funnelData, setFunnelData] = useState<FunnelRow[]>([]);
  const [speedPayload, setSpeedPayload] = useState<SpeedPayload | null>(null);
  const [activityPayload, setActivityPayload] = useState<ActivityPayload | null>(null);
  const [sourceData, setSourceData] = useState<MemberScore[]>([]);
  const [timeToDemoData, setTimeToDemoData] = useState<BucketRow[]>([]);
  const [retroData, setRetroData] = useState<RetroData | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [speedByMember, setSpeedByMember] = useState<Record<string, SpeedData>>({});
  const [velocityLeaderboard, setVelocityLeaderboard] = useState<VelocityEntry[]>([]);

  const [velocityData, setVelocityData] = useState<{ velocity: VelocityRow[]; dropoffs: DropoffRow[] }>({ velocity: [], dropoffs: [] });

  const [loading, setLoading] = useState({
    funnel: true,
    speed: true,
    activity: true,
    source: true,
    timeToDemo: true,
    retro: true,
    team: true,
    velocity: true,
  });

  const markDone = useCallback(
    (key: keyof typeof loading) =>
      setLoading((prev) => ({ ...prev, [key]: false })),
    []
  );

  const loadAll = useCallback(async () => {
    if (!user?.team_member_id) return;
    const memberId = user.team_member_id;
    const h = authHeaders(user.team_member_id);

    // Funnel
    fetch('/api/analytics/funnel', { headers: h })
      .then((r) => r.json())
      .then((d: FunnelRow[]) => { setFunnelData(d); markDone('funnel'); })
      .catch(() => markDone('funnel'));

    // Speed — await so retro can use it
    const speed: SpeedPayload | null = await fetch('/api/analytics/speed', { headers: h })
      .then((r) => r.json())
      .catch(() => null);
    setSpeedPayload(speed);
    markDone('speed');

    // Activity
    fetch('/api/analytics/activity', { headers: h })
      .then((r) => r.json())
      .then((d: ActivityPayload) => { setActivityPayload(d); markDone('activity'); })
      .catch(() => markDone('activity'));

    // Source performance
    fetch('/api/analytics/source', { headers: h })
      .then((r) => r.json())
      .then((d: MemberScore[]) => { setSourceData(d); markDone('source'); })
      .catch(() => markDone('source'));

    // Time-to-demo histogram (derived from leads API)
    fetchTimeToDemoData(memberId)
      .then((d) => { setTimeToDemoData(d); markDone('timeToDemo'); })
      .catch(() => markDone('timeToDemo'));

    // Weekly retro
    fetch('/api/analytics/retro', { headers: h })
      .then((r) => r.json())
      .then((d: RetroApiPayload) => {
        setRetroData({ ...d, ...deriveSpeedTrend(speed) });
        markDone('retro');
      })
      .catch(() => markDone('retro'));

    // Pipeline velocity + drop-offs
    fetch('/api/analytics/velocity', { headers: h })
      .then((r) => r.json())
      .then((d: { velocity: VelocityRow[]; dropoffs: DropoffRow[] }) => { setVelocityData(d); markDone('velocity'); })
      .catch(() => markDone('velocity'));

    // Team speed + velocity (from dashboard)
    fetch('/api/dashboard', { headers: h })
      .then((r) => r.json())
      .then((d) => {
        if (d.members) setMembers(d.members);
        if (d.speed_by_member) setSpeedByMember(d.speed_by_member);
        if (d.velocity_leaderboard) setVelocityLeaderboard(d.velocity_leaderboard);
        markDone('team');
      })
      .catch(() => markDone('team'));
  }, [user?.team_member_id, markDone]);

  useEffect(() => { loadAll(); }, [loadAll]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900">Analytics</h1>

      {/* Row 1: Funnel — full width */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Lead Funnel</h2>
        <FunnelChart data={funnelData} loading={loading.funnel} />
      </section>

      {/* Row 2: Speed (60%) + Activity (40%) */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <section className="col-span-3 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Avg Response Time per Week (hrs)
          </h2>
          <SpeedChart
            weeks={speedPayload?.weeks ?? []}
            series={speedPayload?.series ?? []}
            loading={loading.speed}
          />
        </section>
        <section className="col-span-2 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Activity Volume per Week
          </h2>
          <ActivityChart
            weeks={activityPayload?.weeks ?? []}
            series={activityPayload?.series ?? []}
            loading={loading.activity}
          />
        </section>
      </div>

      {/* Row 3: Source performance (50%) + Time-to-demo (50%) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Pipeline Depth by Owner
          </h2>
          <SourceChart data={sourceData} loading={loading.source} />
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Time to Demo (days from first reply)
          </h2>
          <TimeToDemoChart data={timeToDemoData} loading={loading.timeToDemo} />
        </section>
      </div>

      {/* Row 4: Pipeline Velocity + Drop-offs */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Pipeline Velocity & Drop-offs</h2>
        <VelocityChart velocity={velocityData.velocity} dropoffs={velocityData.dropoffs} loading={loading.velocity} />
      </section>

      {/* Weekly Retro — full width */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Weekly Retro</h2>
        <WeeklyRetro data={retroData} loading={loading.retro} />
      </section>

      {/* Row 5: Speed scorecard (60%) + Velocity leaderboard (40%) */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <section className="col-span-3 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Response Speed by Founder</h2>
          {loading.team ? (
            <div className="h-24 animate-pulse bg-gray-50 rounded-lg" />
          ) : (
            <SpeedScorecard members={members} speedByMember={speedByMember} />
          )}
        </section>
        <section className="col-span-2 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">7-Day Velocity</h2>
          {loading.team ? (
            <div className="h-24 animate-pulse bg-gray-50 rounded-lg" />
          ) : (
            <VelocityLeaderboard leaderboard={velocityLeaderboard} />
          )}
        </section>
      </div>
    </div>
  );
}
