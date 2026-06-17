// GET — ready visual-outreach drafts for the dashboard (+ active senders for
// the sender dropdown). Admin-only (or CRON_SECRET for scripted checks).
// Path under /api/cron/* per the Vercel deployment-protection convention.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();

  const { data: drafts, error } = await supabase
    .from('cold_email_drafts')
    .select('id, email, first_name, full_name, company, domain, industry, image_url, page_slug, subject, body, email_html, sender_account_id, sender_name, ready_at')
    .eq('status', 'ready')
    .not('email_html', 'is', null)
    .order('ready_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: 'database_error', detail: error.message }, { status: 500 });

  const { data: founders } = await supabase
    .from('team_members')
    .select('id, name, email')
    .is('departed_at', null)
    .eq('email_send_paused', false)
    .order('name', { ascending: true });

  const base = (process.env.LANDING_PAGES_BASE_URL || '').replace(/\/$/, '');
  return NextResponse.json({ drafts: drafts ?? [], founders: founders ?? [], pages_base_url: base });
}
