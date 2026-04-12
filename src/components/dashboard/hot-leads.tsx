'use client';

import { Flame } from 'lucide-react';
import { StageBadge } from '@/components/leads/stage-badge';
import Link from 'next/link';
import { LeadStage } from '@/types';

interface HotLead {
  id: string;
  contact_name: string;
  company_name: string;
  stage: string;
  heat_score: number;
  ai_heat_reason: string | null;
  ai_next_action: string | null;
  last_contact_at: string | null;
}

export function HotLeads({ leads }: { leads: HotLead[] }) {
  if (leads.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-4 text-center">
        No scored leads yet. Scores update automatically via cron.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {leads.slice(0, 8).map(lead => {
        const heatColor = lead.heat_score >= 70 ? 'text-red-500' : lead.heat_score >= 40 ? 'text-orange-500' : 'text-gray-400';
        return (
          <Link
            key={lead.id}
            href={`/leads/${lead.id}`}
            className="flex items-start gap-3 rounded-lg border border-gray-100 px-3 py-2.5 hover:bg-gray-50 transition-colors group"
          >
            <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
              <Flame className={`h-4 w-4 ${heatColor}`} />
              <span className={`text-xs font-bold tabular-nums ${heatColor}`}>{lead.heat_score}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600">
                  {lead.contact_name}
                </span>
                <span className="text-xs text-gray-400 truncate">{lead.company_name}</span>
                <StageBadge stage={lead.stage as LeadStage} />
              </div>
              {lead.ai_next_action && (
                <p className="text-xs text-gray-500 truncate">{lead.ai_next_action}</p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
