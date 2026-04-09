export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { generateCallPrep } from '@/lib/ai/call-research';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data: lead } = await supabase
    .from('leads')
    .select('call_prep_notes, call_prep_status, call_prep_generated_at')
    .eq('id', id)
    .single();

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  return NextResponse.json({
    notes: lead.call_prep_notes,
    status: lead.call_prep_status || 'not_started',
    generated_at: lead.call_prep_generated_at,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data: lead } = await supabase
    .from('leads')
    .select('contact_name, contact_email, contact_role, company_name, company_url, company_stage, company_size, call_scheduled_for')
    .eq('id', id)
    .single();

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  try {
    const notes = await generateCallPrep({
      leadId: id,
      contactName: lead.contact_name,
      contactEmail: lead.contact_email || '',
      contactRole: lead.contact_role || undefined,
      companyName: lead.company_name,
      companyUrl: lead.company_url || undefined,
      companyStage: lead.company_stage || undefined,
      companySize: lead.company_size || undefined,
      callScheduledFor: lead.call_scheduled_for || undefined,
    });

    return NextResponse.json({ notes, status: 'completed' });
  } catch (err) {
    return NextResponse.json({
      error: `Research generation failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 'failed',
    }, { status: 500 });
  }
}
