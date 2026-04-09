import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { updateLeadSchema } from '@/lib/validation';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('leads')
    .select(
      `
      *,
      sourced_by_member:team_members!leads_sourced_by_fkey(id, name, email),
      owned_by_member:team_members!leads_owned_by_fkey(id, name, email)
    `
    )
    .eq('id', id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ lead: data });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const body = await req.json();
  // Never allow patching these fields directly via this route
  const { id: _id, created_at: _created_at, is_archived: _is_archived, ...rawUpdate } = body;

  const parsed = updateLeadSchema.safeParse(rawUpdate);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') },
      { status: 400 }
    );
  }
  const updateData = parsed.data;

  const supabase = createAdminClient();

  // Check for handoff note when changing owned_by
  const oldLead = updateData.owned_by
    ? (await supabase.from('leads').select('owned_by').eq('id', id).single()).data
    : null;

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error?.code === 'PGRST116') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log field changes
  if (Object.keys(updateData).length > 0) {
    await supabase.from('activity_log').insert({
      lead_id: id,
      team_member_id: session.id,
      action: 'lead_updated',
      details: { fields: Object.keys(updateData) },
    });
  }

  // If owned_by changed, log handoff
  if (updateData.owned_by && oldLead && updateData.owned_by !== oldLead.owned_by) {
    const handoffNote = body.handoff_note;
    if (handoffNote) {
      await supabase.from('interactions').insert({
        lead_id: id,
        team_member_id: session.id,
        type: 'note',
        body: `Handoff note: ${handoffNote}`,
        occurred_at: new Date().toISOString(),
      });
    }
    await supabase.from('activity_log').insert({
      lead_id: id,
      team_member_id: session.id,
      action: 'lead_reassigned',
      details: { from: oldLead.owned_by, to: updateData.owned_by, handoff_note: body.handoff_note },
    });
  }

  return NextResponse.json({ lead: data });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('leads')
    .update({ is_archived: true, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from('activity_log').insert({
    lead_id: id,
    team_member_id: session.id,
    action: 'lead_archived',
    details: {},
  });

  return NextResponse.json({ success: true });
}
