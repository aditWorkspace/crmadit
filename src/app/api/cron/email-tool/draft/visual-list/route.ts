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

  // optional ?variant=A|B|C filter (browse the A/B test one arm at a time)
  const variantParam = req.nextUrl.searchParams.get('variant');
  const variant = variantParam && ['A', 'B', 'C'].includes(variantParam) ? variantParam : null;

  let q = supabase
    .from('cold_email_drafts')
    .select('id, email, first_name, full_name, company, domain, industry, image_url, page_slug, subject, body, email_html, sender_account_id, sender_name, variant, ready_at')
    .eq('status', 'ready')
    .not('email_html', 'is', null);
  if (variant) q = q.eq('variant', variant);
  const { data: drafts, error } = await q
    .order('ready_at', { ascending: false })
    .limit(variant ? 300 : 200);
  if (error) return NextResponse.json({ error: 'database_error', detail: error.message }, { status: 500 });

  // per-variant counts across the whole ready visual pool (cheap single-column scan)
  const { data: allVariants } = await supabase
    .from('cold_email_drafts')
    .select('variant')
    .eq('status', 'ready')
    .not('email_html', 'is', null);
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, total: 0 };
  for (const r of allVariants ?? []) {
    const v = (r as { variant: string | null }).variant ?? 'A';
    counts[v] = (counts[v] ?? 0) + 1;
    counts.total += 1;
  }

  const { data: founders } = await supabase
    .from('team_members')
    .select('id, name, email')
    .is('departed_at', null)
    .eq('email_send_paused', false)
    .order('name', { ascending: true });

  const base = (process.env.LANDING_PAGES_BASE_URL || '').replace(/\/$/, '');
  return NextResponse.json({ drafts: drafts ?? [], founders: founders ?? [], pages_base_url: base, counts });
}
