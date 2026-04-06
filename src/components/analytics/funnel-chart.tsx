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

interface FunnelRow {
  stage: string;
  label: string;
  count: number;
  conversion_rate: number | null;
}

interface Props {
  data: FunnelRow[];
  loading: boolean;
}

const BAR_COLOR = '#6366f1';

export function FunnelChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400 animate-pulse">
        Loading funnel…
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="h-64 flex items-center justify-center text-sm text-gray-400">
        No lead data yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 60, left: 12, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 12 }} />
          <YAxis
            type="category"
            dataKey="label"
            width={110}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            formatter={(value, _name, props) => {
              const row = (props as { payload?: FunnelRow }).payload;
              const cr = row?.conversion_rate;
              const count = value ?? 0;
              return [
                `${count} leads${cr !== null && cr !== undefined ? ` (${cr}% from prev)` : ''}`,
                'Count',
              ];
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => (
              <Cell
                key={entry.stage}
                fill={`hsl(${240 - index * 20}, 65%, ${55 + index * 3}%)`}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Conversion rate annotations */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pl-2 text-xs text-gray-500">
        {data.map((row) =>
          row.conversion_rate !== null ? (
            <span key={row.stage}>
              {row.label}:{' '}
              <span className="font-medium text-gray-700">{row.conversion_rate}%</span>
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}
