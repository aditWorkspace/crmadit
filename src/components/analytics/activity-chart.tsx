'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface Series {
  type: string;
  data: number[];
}

interface Props {
  weeks: string[];
  series: Series[];
  loading: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  email: '#6366f1',
  call: '#10b981',
  note: '#f59e0b',
  stage_change: '#ec4899',
};

const TYPE_LABELS: Record<string, string> = {
  email: 'Email',
  call: 'Call',
  note: 'Note',
  stage_change: 'Stage Change',
};

export function ActivityChart({ weeks, series, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400 animate-pulse">
        Loading activity data…
      </div>
    );
  }

  const hasData = series.some((s) => s.data.some((v) => v > 0));
  if (!hasData) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400">
        No activity data yet.
      </div>
    );
  }

  const chartData = weeks.map((week, i) => {
    const point: Record<string, string | number> = { week };
    for (const s of series) {
      point[s.type] = s.data[i] ?? 0;
    }
    return point;
  });

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="week" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Legend
          formatter={(value: string) => TYPE_LABELS[value] ?? value}
          wrapperStyle={{ fontSize: 12 }}
        />
        {series.map((s) => (
          <Bar
            key={s.type}
            dataKey={s.type}
            stackId="a"
            fill={TYPE_COLORS[s.type] ?? '#94a3b8'}
            name={TYPE_LABELS[s.type] ?? s.type}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
