'use client';

interface RetroData {
  leads_moved_forward: { contact_name: string; company_name: string; from_stage: string; to_stage: string }[];
  new_leads: { contact_name: string; company_name: string }[];
  stale_leads: { contact_name: string; company_name: string; stage: string; hours_stale: number }[];
  total_active: number;
  speed_trend: 'faster' | 'slower' | 'same' | 'no_data';
  avg_response_this_week: number | null;
  avg_response_last_week: number | null;
}

interface Props {
  data: RetroData | null;
  loading: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  replied: 'Replied',
  scheduling: 'Scheduling',
  scheduled: 'Scheduled',
  call_completed: 'Call Completed',
  post_call: 'Post Call',
  demo_sent: 'Demo Sent',
  active_user: 'Active User',
  paused: 'Paused',
  dead: 'Dead',
};

export function WeeklyRetro({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-gray-100" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-sm text-gray-400">No retro data available.</div>
    );
  }

  const speedLabel = () => {
    if (data.speed_trend === 'no_data') return null;
    const thisWk = data.avg_response_this_week?.toFixed(1);
    const lastWk = data.avg_response_last_week?.toFixed(1);
    if (data.speed_trend === 'faster')
      return `Response time improved this week: ${thisWk}h avg vs ${lastWk}h last week.`;
    if (data.speed_trend === 'slower')
      return `Response time slowed this week: ${thisWk}h avg vs ${lastWk}h last week.`;
    return `Response time steady at ~${thisWk}h avg.`;
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Leads moved forward */}
      <div className="rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Moved Forward This Week
          <span className="ml-2 text-xs font-normal text-gray-400">
            ({data.leads_moved_forward.length})
          </span>
        </h3>
        {data.leads_moved_forward.length === 0 ? (
          <p className="text-sm text-gray-400">None this week.</p>
        ) : (
          <ul className="space-y-1">
            {data.leads_moved_forward.slice(0, 8).map((l, i) => (
              <li key={i} className="text-sm text-gray-700">
                <span className="font-medium">{l.contact_name}</span>{' '}
                <span className="text-gray-400">({l.company_name})</span>
                <span className="text-xs text-gray-400 ml-1">
                  {STAGE_LABELS[l.from_stage] ?? l.from_stage} →{' '}
                  {STAGE_LABELS[l.to_stage] ?? l.to_stage}
                </span>
              </li>
            ))}
            {data.leads_moved_forward.length > 8 && (
              <li className="text-xs text-gray-400">
                +{data.leads_moved_forward.length - 8} more
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Stale leads */}
      <div className="rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Stale Leads
          <span className="ml-2 text-xs font-normal text-gray-400">
            ({data.stale_leads.length})
          </span>
        </h3>
        {data.stale_leads.length === 0 ? (
          <p className="text-sm text-green-600">No stale leads. Great job!</p>
        ) : (
          <ul className="space-y-1">
            {data.stale_leads.slice(0, 8).map((l, i) => (
              <li key={i} className="text-sm text-gray-700">
                <span className="font-medium">{l.contact_name}</span>{' '}
                <span className="text-gray-400">({l.company_name})</span>
                <span className="text-xs text-red-500 ml-1">
                  {l.hours_stale}h in {STAGE_LABELS[l.stage] ?? l.stage}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Summary</h3>
        <div className="text-sm text-gray-600 space-y-2">
          <p>
            <span className="font-medium text-gray-900">{data.total_active}</span> active leads
            in pipeline.
          </p>
          <p>
            <span className="font-medium text-gray-900">{data.new_leads.length}</span> new leads
            added this week.
          </p>
          {speedLabel() && <p className="text-gray-600">{speedLabel()}</p>}
        </div>
      </div>
    </div>
  );
}
