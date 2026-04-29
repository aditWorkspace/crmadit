// Admin endpoint: priority CSV upload + listing.
// Two-step flow per spec §10.2:
//   1. POST without `confirmed: true` → returns a validation report
//      (valid rows, blacklisted, dead-lead matches, active-lead matches)
//      so the admin sees what will happen before any DB writes.
//   2. POST with `confirmed: true` → actually inserts the rows that
//      survived the admin's per-category override flags.
//
// See spec §10 for the full data model.

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
  /** When true, perform the actual insert. When false/missing, return validation report only. */
  confirmed?: boolean;
  /** Per-category override flags. */
  override_blacklist?: boolean;
  override_dead_leads?: boolean;
  use_lead_owner?: boolean;
}

interface ValidationReport {
  valid_count: number;
  blacklisted_emails: string[];
  dead_lead_emails: string[];
  active_lead_owners: Record<string, string>; // email → owner_team_member_id
  malformed: string[];
  // What WOULD be inserted given current flags:
  would_insert: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PT_TZ = 'America/Los_Angeles';

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

  // Reject weekend dates server-side (defense in depth — UI also restricts).
  // Parse the date as-PT and check day-of-week.
  const dateInPT = new Date(`${body.scheduled_for_date}T12:00:00-08:00`);
  const dowName = new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, weekday: 'short' }).format(dateInPT);
  if (dowName === 'Sat' || dowName === 'Sun') {
    return NextResponse.json({
      error: `scheduled_for_date ${body.scheduled_for_date} is a weekend (${dowName}) — campaigns only run Mon–Fri`,
    }, { status: 400 });
  }

  // Normalize + validate each row's email
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

  const supabase = createAdminClient();
  const emails = normalized.map(r => r.email);

  // Categorize rows
  const [blacklistedRes, leadRes] = await Promise.all([
    supabase
      .from('email_blacklist')
      .select('email')
      .in('email', emails),
    // Lowercase-normalize on both sides. Postgres has no built-in lower()
    // function in PostgREST filters, so we use ilike with each candidate.
    // For 500 rows this is fine; for larger batches we'd want an RPC.
    supabase
      .from('leads')
      .select('contact_email, owned_by, stage')
      .in('contact_email', emails),
  ]);

  const blacklistedSet = new Set(
    ((blacklistedRes.data ?? []) as Array<{ email: string }>).map(b => b.email.toLowerCase())
  );

  const deadLeadEmails = new Set<string>();
  const activeLeadOwners = new Map<string, string>();
  for (const l of (leadRes.data ?? []) as Array<{ contact_email: string; owned_by: string | null; stage: string }>) {
    const e = l.contact_email.toLowerCase();
    if (l.stage === 'dead') {
      deadLeadEmails.add(e);
    } else if (l.owned_by) {
      activeLeadOwners.set(e, l.owned_by);
    }
  }

  // Compute "would insert" given current flags
  let wouldInsertCount = 0;
  for (const r of normalized) {
    const isBlacklisted = blacklistedSet.has(r.email);
    const isDead = deadLeadEmails.has(r.email);
    if (isBlacklisted && !body.override_blacklist) continue;
    if (isDead && !body.override_dead_leads) continue;
    wouldInsertCount++;
  }

  const report: ValidationReport = {
    valid_count: normalized.length,
    blacklisted_emails: Array.from(blacklistedSet),
    dead_lead_emails: Array.from(deadLeadEmails),
    active_lead_owners: body.use_lead_owner
      ? Object.fromEntries(activeLeadOwners.entries())
      : {},
    malformed,
    would_insert: wouldInsertCount,
  };

  // Step 1: validate-only → return report without inserting
  if (!body.confirmed) {
    return NextResponse.json({ validation: report });
  }

  // Step 2: confirmed → insert the rows that survive overrides
  if (malformed.length > 0) {
    return NextResponse.json({
      error: `cannot insert with ${malformed.length} malformed email(s); fix and re-validate`,
      validation: report,
    }, { status: 400 });
  }

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

  for (const r of normalized) {
    const isBlacklisted = blacklistedSet.has(r.email);
    const isDead = deadLeadEmails.has(r.email);
    if (isBlacklisted && !body.override_blacklist) continue;
    if (isDead && !body.override_dead_leads) continue;
    inserts.push({
      email: r.email,
      first_name: r.first_name ?? null,
      company: r.company ?? null,
      uploaded_by: session.id,
      scheduled_for_date: body.scheduled_for_date,
      notes: body.notes ?? null,
      // Per-row: only true when THIS row was actually blacklisted (and admin overrode).
      override_blacklist: isBlacklisted,
      override_owner: body.use_lead_owner ? (activeLeadOwners.get(r.email) ?? null) : null,
      status: 'pending',
    });
  }

  if (inserts.length === 0) {
    return NextResponse.json({
      inserted: 0,
      validation: report,
      note: 'all rows excluded by validation; pass override flags to include',
    });
  }

  const { data: insertedRows, error } = await supabase
    .from('email_send_priority_queue')
    .insert(inserts)
    .select('id');
  if (error) {
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
    validation: report,
  });
}
