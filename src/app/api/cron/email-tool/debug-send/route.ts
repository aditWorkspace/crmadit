// Admin-only end-to-end smoke endpoint for the cold-outreach pipeline.
// Sends ONE real email via the actual production code path so you can
// verify Gmail headers, plus-aliasing, etc., against your `+test` alias
// before going live.
//
// Path uses the /api/cron/* prefix per project convention (Vercel
// deployment-protection HTML-404 workaround). Not actually a cron route.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendCampaignEmail } from '@/lib/email-tool/send';
import { getCampaignGmailClient, type CampaignGmailClient } from '@/lib/gmail/client';

export const maxDuration = 60;

interface RequestBody {
  recipient_email?: string;
  founder_id?: string;
  variant_id?: string;
  first_name?: string;
  company?: string;
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const body: RequestBody = await req.json().catch(() => ({}));
  const { recipient_email, founder_id, variant_id } = body;
  if (!recipient_email || !founder_id || !variant_id) {
    return NextResponse.json(
      { error: 'recipient_email, founder_id, variant_id are required' },
      { status: 400 }
    );
  }
  const firstName = body.first_name ?? 'Test';
  const company = body.company ?? 'Test Co';

  const supabase = createAdminClient();

  // Look up the founder
  const { data: founderRow } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected')
    .eq('id', founder_id)
    .maybeSingle();
  if (!founderRow) {
    return NextResponse.json({ error: 'founder not found' }, { status: 404 });
  }
  const founder = founderRow as { id: string; name: string; email: string; gmail_connected: boolean };
  if (!founder.gmail_connected) {
    return NextResponse.json(
      { error: 'founder has no connected Gmail (gmail_connected=false)' },
      { status: 400 }
    );
  }

  // Look up the variant
  const { data: variantRow } = await supabase
    .from('email_template_variants')
    .select('subject_template, body_template')
    .eq('id', variant_id)
    .maybeSingle();
  if (!variantRow) {
    return NextResponse.json({ error: 'variant not found' }, { status: 404 });
  }
  const variant = variantRow as { subject_template: string; body_template: string };

  // Get gmail client for this founder
  let gmail: CampaignGmailClient;
  try {
    gmail = await getCampaignGmailClient(founder.id);
  } catch (err) {
    const e = err as Error;
    return NextResponse.json(
      { error: `gmail_client_init_failed: ${e.message}` },
      { status: 500 }
    );
  }

  // Send via the production code path
  const debugQueueRowId = `debug-${Date.now()}`;
  const outcome = await sendCampaignEmail({
    queueRow: {
      id: debugQueueRowId,
      account_id: founder.id,
      recipient_email: recipient_email.toLowerCase(),
      recipient_name: firstName,
      recipient_company: company,
      template_variant_id: variant_id,
      send_at: new Date().toISOString(),
      status: 'pending',
    },
    variant,
    founder: { id: founder.id, name: founder.name, email: founder.email },
    sendMode: 'production',
    allowlist: [],
  }, gmail);

  return NextResponse.json({ outcome });
}
