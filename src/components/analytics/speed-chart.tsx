'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface Series {
  name: string;
  data: (number | null)[];
}

interface Props {
  weeks: string[];
  series: Series[];
  loading: boolean;
}

const COLORS = ['#6366f1', '#f59e0b', '#10b981'];

export function SpeedChart({ weeks, series, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400 animate-pulse">
        Loading speed data…
      </div>
    );
  }

  const hasData = series.some((s) => s.data.some((v) => v !== null));
  if (!hasData) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400">
        No response time data yet.
      </div>
    );
  }

  // Reshape into recharts-friendly format
  const chartData = weeks.map((week, i) => {
    const point: Record<string, string | number | null> = { week };
    for (const s of series) {
      point[s.name] = s.data[i] ?? null;
    }
    return point;
  });

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="week" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis
          tick={{ fontSize: 11 }}
          label={{ value: 'hrs', angle: -90, position: 'insideLeft', fontSize: 11 }}
        />
        <Tooltip formatter={(v) => [`${v ?? 0}h`, 'Avg reply time']} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, i) => (
          <Line
            key={s.name}
            type="monotone"
            dataKey={s.name}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
