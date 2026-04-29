// Admin endpoint: read + update email_send_schedule fields.
// GET returns the singleton row.
// PATCH lets admin update enabled, send_mode, warmup_started_on.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const ALLOWED_SEND_MODES = new Set(['production', 'dry_run', 'allowlist']);

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_schedule')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ schedule: data });
}

export async function PATCH(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
  if (typeof body.send_mode === 'string') {
    if (!ALLOWED_SEND_MODES.has(body.send_mode)) {
      return NextResponse.json({ error: `send_mode must be one of: production, dry_run, allowlist` }, { status: 400 });
    }
    updates.send_mode = body.send_mode;
  }
  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: 'no valid fields to update' }, { status: 400 });
  }

  // When enabling for the first time, also stamp warmup_started_on
  if (body.enabled === true) {
    const { data: current } = await createAdminClient()
      .from('email_send_schedule')
      .select('warmup_started_on')
      .eq('id', 1)
      .single();
    if (!(current as { warmup_started_on: string | null } | null)?.warmup_started_on) {
      updates.warmup_started_on = new Date().toISOString().split('T')[0];
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_schedule')
    .update(updates)
    .eq('id', 1)
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ schedule: data });
}
