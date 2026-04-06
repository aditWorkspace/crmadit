'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { STAGE_ORDER } from '@/lib/constants';

interface MemberScore {
  name: string;
  avg_stage_score: number;
  lead_count: number;
}

interface Props {
  data: MemberScore[];
  loading: boolean;
}

const COLORS = ['#6366f1', '#f59e0b', '#10b981'];

function stageScore(stage: string): number {
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  return idx >= 0 ? idx : 0;
}

export { stageScore };

export function SourceChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400 animate-pulse">
        Loading source data…
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400">
        No data yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis
          tick={{ fontSize: 11 }}
          domain={[0, STAGE_ORDER.length - 1]}
          label={{ value: 'Avg stage', angle: -90, position: 'insideLeft', fontSize: 11 }}
        />
        <Tooltip
          formatter={(value, _name, props) => {
            const row = (props as { payload?: MemberScore }).payload;
            const v = typeof value === 'number' ? value : 0;
            return [`${v.toFixed(1)} (${row?.lead_count ?? 0} leads)`, 'Avg Stage Score'];
          }}
        />
        <Bar dataKey="avg_stage_score" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
