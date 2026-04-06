import { NextRequest, NextResponse } from 'next/server';
import { detectStaleLeads, createStaleFollowUps } from '@/lib/automation/stale-detection';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const staleAlerts = await detectStaleLeads();
  await createStaleFollowUps(staleAlerts);

  return NextResponse.json({
    status: 'ok',
    stale_leads: staleAlerts.length,
    alerts: staleAlerts.map(a => ({ lead_id: a.lead_id, contact: a.contact_name, hours: a.hours_stale })),
  });
}
