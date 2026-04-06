'use client';

import { Trophy, Minus } from 'lucide-react';

interface Entry {
  id: string;
  name: string;
  advances: number;
}

interface Props {
  leaderboard: Entry[];
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function VelocityLeaderboard({ leaderboard }: Props) {
  const total = leaderboard.reduce((s, e) => s + e.advances, 0);

  if (total === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-400 flex items-center gap-2">
        <Minus className="h-4 w-4" />
        No stage advances in the last 7 days.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="divide-y divide-gray-50">
        {leaderboard.map((entry, i) => {
          const pct = total > 0 ? Math.round((entry.advances / total) * 100) : 0;
          const isTop = i === 0 && entry.advances > 0;
          return (
            <div key={entry.id} className="px-5 py-3 flex items-center gap-3">
              <span className="text-base w-6 text-center flex-shrink-0">
                {MEDALS[i] ?? <span className="text-gray-300 text-sm">{i + 1}</span>}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-sm font-medium ${isTop ? 'text-gray-900' : 'text-gray-600'}`}>
                    {entry.name}
                  </span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    {entry.advances} advance{entry.advances !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isTop ? 'bg-amber-400' : 'bg-gray-300'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-5 py-2.5 border-t border-gray-50 flex items-center gap-1.5 text-xs text-gray-400">
        <Trophy className="h-3 w-3" />
        {total} total forward advances in the last 7 days
      </div>
    </div>
  );
}
