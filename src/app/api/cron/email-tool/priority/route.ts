// Admin endpoint: priority CSV upload + listing.
// See spec §10.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from '@/lib/email-tool/safety-limits';

interface UploadRow {
  email: string;
  first_name?: string;
  company?: string;
}

interface UploadBody {
  rows: UploadRow[];
  scheduled_for_date: string;
  notes?: string;
  override_blacklist?: boolean;
  use_lead_owner?: boolean;
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_priority_queue')
    .select('*')
    .order('uploaded_at', { ascending: false })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as UploadBody | null;
  if (!body) {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'rows[] is required and must be non-empty' }, { status: 400 });
  }
  if (body.rows.length > SAFETY_LIMITS.PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD) {
    return NextResponse.json({
      error: `max ${SAFETY_LIMITS.PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD} rows per batch (got ${body.rows.length})`,
    }, { status: 400 });
  }
  if (!body.scheduled_for_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduled_for_date)) {
    return NextResponse.json({
      error: 'scheduled_for_date must be a YYYY-MM-DD string',
    }, { status: 400 });
  }

  // Normalize + validate each row's email
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalized: UploadRow[] = [];
  const malformed: string[] = [];
  for (const r of body.rows) {
    const email = (r.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      malformed.push(email || '(empty)');
      continue;
    }
    normalized.push({
      email,
      first_name: r.first_name?.trim() || undefined,
      company: r.company?.trim() || undefined,
    });
  }
  if (malformed.length > 0) {
    return NextResponse.json({
      error: `${malformed.length} malformed email(s)`,
      malformed,
    }, { status: 400 });
  }

  const supabase = createAdminClient();
  const emails = normalized.map(r => r.email);

  // Blacklist check
  const { data: blacklisted } = await supabase
    .from('email_blacklist')
    .select('email')
    .in('email', emails);
  const blacklistedSet = new Set(((blacklisted ?? []) as Array<{ email: string }>).map(b => b.email));

  // Lead-owner attribution (optional)
  let leadOwners = new Map<string, string>();
  if (body.use_lead_owner) {
    const { data: leadRows } = await supabase
      .from('leads')
      .select('contact_email, owned_by')
      .in('contact_email', emails);
    leadOwners = new Map(
      ((leadRows ?? []) as Array<{ contact_email: string; owned_by: string }>)
        .filter(l => l.owned_by)
        .map(l => [l.contact_email.toLowerCase(), l.owned_by]),
    );
  }

  // Filter rows + build inserts
  const inserts: Array<{
    email: string;
    first_name: string | null;
    company: string | null;
    uploaded_by: string;
    scheduled_for_date: string;
    notes: string | null;
    override_blacklist: boolean;
    override_owner: string | null;
    status: 'pending';
  }> = [];
  let skippedBlacklisted = 0;
  for (const r of normalized) {
    const isBlacklisted = blacklistedSet.has(r.email);
    if (isBlacklisted && !body.override_blacklist) {
      skippedBlacklisted++;
      continue;
    }
    inserts.push({
      email: r.email,
      first_name: r.first_name ?? null,
      company: r.company ?? null,
      uploaded_by: session.id,
      scheduled_for_date: body.scheduled_for_date,
      notes: body.notes ?? null,
      override_blacklist: isBlacklisted ? true : (body.override_blacklist ?? false),
      override_owner: leadOwners.get(r.email) ?? null,
      status: 'pending',
    });
  }

  if (inserts.length === 0) {
    return NextResponse.json({
      inserted: 0,
      skipped_blacklisted: skippedBlacklisted,
      note: 'all rows were blacklisted; pass override_blacklist=true to include them',
    });
  }

  const { data: insertedRows, error } = await supabase
    .from('email_send_priority_queue')
    .insert(inserts)
    .select('id');
  if (error) {
    // Most likely cause: partial unique index collision — same email
    // already pending or scheduled for same date.
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({
        error: 'one or more rows already exist as pending/scheduled for that date',
        detail: error.message,
      }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    inserted: insertedRows?.length ?? 0,
    skipped_blacklisted: skippedBlacklisted,
  });
}
