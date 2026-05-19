// POST /api/dripify/leads/[id]/retry
// Resets a dripify_leads row back to pending_enrich so the next cron tick
// picks it up. Useful for unresolvable rows after the user thinks the data
// has improved (e.g., they manually filled in company_domain), or for
// send_failed rows where the underlying Gmail issue is fixed.
//
// We deliberately don't reset rows in status='sent' or 'replied' — those
// are terminal-ish and resetting would re-send a duplicate.

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export const dynamic = 'force-dynamic';

const RETRY_ALLOWED_FROM = ['unresolvable', 'send_failed', 'skipped'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data: leadRow } = await supabase
    .from('dripify_leads')
    .select('id, status, resolved_email')
    .eq('id', id)
    .maybeSingle();
  if (!leadRow) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 });
  const lead = leadRow as { id: string; status: string; resolved_email: string | null };

  if (!RETRY_ALLOWED_FROM.includes(lead.status)) {
    return NextResponse.json(
      { error: 'cannot_retry_from_status', status: lead.status },
      { status: 400 },
    );
  }

  // For send_failed rows we keep the resolved_email and just bounce back to
  // email_queued. For unresolvable rows we re-attempt enrichment from scratch.
  const nextStatus = lead.status === 'send_failed' && lead.resolved_email ? 'email_queued' : 'pending_enrich';

  const { error: updateErr } = await supabase
    .from('dripify_leads')
    .update({
      status: nextStatus,
      last_attempt_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, new_status: nextStatus });
}
