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

interface Props {
  velocity: VelocityRow[];
  dropoffs: DropoffRow[];
  loading: boolean;
}

export function VelocityChart({ velocity, dropoffs, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-400 text-sm">Loading...</div>
    );
  }

  const velocityData = velocity.filter(v => v.avg_days !== null);

  return (
    <div className="space-y-6">
      {/* Pipeline Velocity */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Avg. Days per Stage</h3>
        {velocityData.length === 0 ? (
          <p className="text-xs text-gray-400">Not enough stage transitions yet</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={velocityData} layout="vertical" margin={{ left: 80, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={v => `${v}d`} fontSize={11} />
              <YAxis type="category" dataKey="label" fontSize={11} width={80} />
              <Tooltip
                formatter={(value) => [`${value} days`, 'Avg. time']}
              />
              <Bar dataKey="avg_days" fill="#6366f1" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Conversion Drop-offs */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Stage Drop-off Rates</h3>
        <div className="space-y-1.5">
          {dropoffs.map(d => (
            <div key={d.from_stage} className="flex items-center gap-2 text-xs">
              <span className="w-24 text-right text-gray-500 truncate">{d.from_label}</span>
              <span className="text-gray-400">→</span>
              <span className="w-24 text-gray-500 truncate">{d.to_label}</span>
              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${100 - d.drop_rate}%`,
                    backgroundColor: d.drop_rate > 50 ? '#ef4444' : d.drop_rate > 25 ? '#f59e0b' : '#22c55e',
                  }}
                />
              </div>
              <span className={`w-10 text-right font-medium ${d.drop_rate > 50 ? 'text-red-500' : d.drop_rate > 25 ? 'text-amber-500' : 'text-green-500'}`}>
                {d.drop_rate}%
              </span>
              <span className="w-16 text-gray-400">{d.from_count}→{d.to_count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
