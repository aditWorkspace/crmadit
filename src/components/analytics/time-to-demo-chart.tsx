'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface BucketRow {
  label: string;
  count: number;
}

interface Props {
  data: BucketRow[];
  loading: boolean;
}

export function TimeToDemoChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400 animate-pulse">
        Loading histogram…
      </div>
    );
  }

  const hasData = data.some((d) => d.count > 0);
  if (!hasData) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400">
        No demo timeline data yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip formatter={(v) => [v ?? 0, 'Leads']} />
        <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
