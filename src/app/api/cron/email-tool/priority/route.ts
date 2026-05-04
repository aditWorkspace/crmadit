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
  /** Synergy s1: by default we BLOCK any row whose email is already an active
   *  lead (don't double-email someone already in the pipeline). Set true to
   *  bypass — useful for "I want to follow up on this lead via outreach". */
  override_active_leads?: boolean;
}

interface ValidationReport {
  valid_count: number;
  blacklisted_emails: string[];
  dead_lead_emails: string[];
  /** Synergy s1: rows that are EXACT-EMAIL matches with active leads. Blocked
   *  by default unless `override_active_leads: true`. Map value is the owning
   *  founder's id so the operator knows who's already on this prospect. */
  active_lead_emails: Record<string, string>;
  /** Synergy s2: rows whose domain matches an active lead's domain (but not
   *  the same email). These rows get auto-routed to the existing owner so a
   *  consistent founder owns the relationship at that company. Map value is
   *  the founder id we'd route to. Always informational — no block. */
  domain_routed_emails: Record<string, string>;
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
  const domains = Array.from(new Set(
    emails.map(e => e.split('@')[1]?.toLowerCase()).filter((d): d is string => !!d)
  ));

  // Categorize rows. Three queries in parallel:
  //   1. blacklist matches
  //   2. exact-email lead matches (synergy s1: block active duplicates)
  //   3. domain-level lead matches (synergy s2: auto-route to existing owner)
  // For (3) we ilike each domain pattern; for ≤500 batch sizes this is fine.
  const domainOrFilter = domains.length > 0
    ? domains.map(d => `contact_email.ilike.%@${d}`).join(',')
    : null;
  const [blacklistedRes, exactLeadRes, domainLeadRes] = await Promise.all([
    supabase
      .from('email_blacklist')
      .select('email')
      .in('email', emails),
    supabase
      .from('leads')
      .select('contact_email, owned_by, stage')
      .in('contact_email', emails),
    domainOrFilter
      ? supabase
          .from('leads')
          .select('contact_email, owned_by, stage, updated_at')
          .or(domainOrFilter)
          .neq('stage', 'dead')
          .not('owned_by', 'is', null)
          .order('updated_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Synergy s2 — exclude departed founders from auto-routing. A departed
  // founder can't send mail, so routing to them would queue rows that
  // never drain. Pull active-founder ids once and filter the routing
  // tables.
  const { data: activeFoundersData } = await supabase
    .from('team_members')
    .select('id')
    .is('departed_at', null);
  const activeFounderIds = new Set(
    ((activeFoundersData ?? []) as Array<{ id: string }>).map(f => f.id)
  );

  const blacklistedSet = new Set(
    ((blacklistedRes.data ?? []) as Array<{ email: string }>).map(b => b.email.toLowerCase())
  );

  const deadLeadEmails = new Set<string>();
  const activeLeadOwners = new Map<string, string>();
  for (const l of (exactLeadRes.data ?? []) as Array<{ contact_email: string; owned_by: string | null; stage: string }>) {
    const e = l.contact_email.toLowerCase();
    if (l.stage === 'dead') {
      deadLeadEmails.add(e);
    } else if (l.owned_by && activeFounderIds.has(l.owned_by)) {
      // Only route to ACTIVE founders — a departed founder can't send,
      // so an exact-match lead owned by them must fall through to round-
      // robin assignment among active founders.
      activeLeadOwners.set(e, l.owned_by);
    }
  }

  // Synergy s2 — domain → owner. First owner per domain (most-recently-updated
  // active lead) wins. Skip exact-email matches (those are already in
  // activeLeadOwners and don't need domain inference). Active founders only.
  const domainOwners = new Map<string, string>();
  for (const l of (domainLeadRes.data ?? []) as Array<{ contact_email: string; owned_by: string | null }>) {
    if (!l.owned_by || !activeFounderIds.has(l.owned_by)) continue;
    const domain = l.contact_email.split('@')[1]?.toLowerCase();
    if (domain && !domainOwners.has(domain)) {
      domainOwners.set(domain, l.owned_by);
    }
  }

  // Map each row to its s2-derived auto-route owner (only for rows that AREN'T
  // exact-email matches — those get the exact-match owner anyway).
  const domainRoutedEmails: Record<string, string> = {};
  for (const r of normalized) {
    if (activeLeadOwners.has(r.email)) continue; // exact match wins, skip
    const domain = r.email.split('@')[1]?.toLowerCase();
    const owner = domain ? domainOwners.get(domain) : undefined;
    if (owner) domainRoutedEmails[r.email] = owner;
  }

  // Compute "would insert" given current flags. s1 blocks active-lead exact
  // matches by default; the override flag bypasses.
  let wouldInsertCount = 0;
  for (const r of normalized) {
    const isBlacklisted = blacklistedSet.has(r.email);
    const isDead = deadLeadEmails.has(r.email);
    const isActiveLead = activeLeadOwners.has(r.email);
    if (isBlacklisted && !body.override_blacklist) continue;
    if (isDead && !body.override_dead_leads) continue;
    if (isActiveLead && !body.override_active_leads) continue;
    wouldInsertCount++;
  }

  const report: ValidationReport = {
    valid_count: normalized.length,
    blacklisted_emails: Array.from(blacklistedSet),
    dead_lead_emails: Array.from(deadLeadEmails),
    active_lead_emails: Object.fromEntries(activeLeadOwners.entries()),
    domain_routed_emails: domainRoutedEmails,
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
    const isActiveLead = activeLeadOwners.has(r.email);
    if (isBlacklisted && !body.override_blacklist) continue;
    if (isDead && !body.override_dead_leads) continue;
    if (isActiveLead && !body.override_active_leads) continue;
    // s2: route to the owning founder. Exact-email match wins over
    // domain match (an exact match means we already know who owns this
    // specific person).
    const exactOwner = activeLeadOwners.get(r.email);
    const domainOwner = domainRoutedEmails[r.email];
    inserts.push({
      email: r.email,
      first_name: r.first_name ?? null,
      company: r.company ?? null,
      uploaded_by: session.id,
      scheduled_for_date: body.scheduled_for_date,
      notes: body.notes ?? null,
      // Per-row: only true when THIS row was actually blacklisted (and admin overrode).
      override_blacklist: isBlacklisted,
      override_owner: exactOwner ?? domainOwner ?? null,
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
