'use client';

import { TeamMember } from '@/types';
import { formatHours, cn } from '@/lib/utils';
import { SPEED_COLOR } from '@/lib/constants';

interface SpeedData {
  avg_reply: number | null;
  avg_demo: number | null;
  active_count: number;
}

interface SpeedScorecardProps {
  members: TeamMember[];
  speedByMember: Record<string, SpeedData>;
}

export function SpeedScorecard({ members, speedByMember }: SpeedScorecardProps) {
  return (
    <div className="space-y-3">
      {members.map(member => {
        const speed = speedByMember[member.id];
        if (!speed) return null;
        return (
          <div key={member.id} className="flex items-center gap-4">
            <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-xs font-medium flex-shrink-0">
              {member.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-700">{member.name}</p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="text-center">
                <p className={cn('font-medium', speed.avg_reply != null ? SPEED_COLOR(speed.avg_reply) : 'text-gray-300')}>
                  {speed.avg_reply != null ? formatHours(speed.avg_reply) : '—'}
                </p>
                <p className="text-gray-400">reply</p>
              </div>
              <div className="text-center">
                <p className={cn('font-medium', speed.avg_demo != null ? SPEED_COLOR(speed.avg_demo) : 'text-gray-300')}>
                  {speed.avg_demo != null ? formatHours(speed.avg_demo) : '—'}
                </p>
                <p className="text-gray-400">demo</p>
              </div>
              <div className="text-center">
                <p className="font-medium text-gray-700">{speed.active_count}</p>
                <p className="text-gray-400">active</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
