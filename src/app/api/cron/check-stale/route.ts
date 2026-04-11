export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { detectStaleLeads, createStaleFollowUps } from '@/lib/automation/stale-detection';
import { verifyCronAuth } from '@/lib/auth/cron';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
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

export const GET = handler;
export const POST = handler;
