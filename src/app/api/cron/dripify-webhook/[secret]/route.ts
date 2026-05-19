// POST /api/cron/dripify-webhook/<DRIPIFY_WEBHOOK_SECRET>
//
// Webhook receiver for Dripify (LinkedIn outreach automation). Dripify hits
// this URL when a configured trigger fires — currently "After a lead's post
// is liked" for prospects who ignored the connection request and then engaged
// with one of our posts.
//
// Auth model: URL-embedded secret. Dripify cannot send custom auth headers, so
// the secret lives in the URL path. Compared with timingSafeEqual.
//
// Path note: route lives under /api/cron/* (not /api/webhooks/*) because the
// Vercel project's Deployment Protection allowlist passes /api/cron/* through
// to the function. Other paths get edge-blocked with a Vercel-owned 401 before
// our handler runs. The prefix doesn't imply a scheduled cron — it's just the
// path that bypasses the edge gate.
//
// Behavior:
//   - Always logs the raw payload to dripify_webhook_events (signature_ok=true/false)
//     so we can debug bad-signature traffic and discover the payload shape.
//   - On valid signature: parses payload (best-effort, tolerant of unknown shapes)
//     and inserts a dripify_leads row with status='pending_enrich'. Dedupes on
//     linkedin_url via the unique partial index from migration 036.
//   - Always returns 200 on valid signature (even when we can't extract a usable
//     lead) — Dripify retries on non-2xx, and we don't want to spin if our parser
//     is wrong; the raw payload is already captured for follow-up.
//   - Returns 401 on bad signature (raw payload still logged with signature_ok=false).
//
// PR1 scope: payload logging + dedupe insert only. Enrichment + send are run
// out-of-band by /api/cron/dripify-process (PR2).

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

interface DripifyLeadInsert {
  linkedin_url: string | null;
  linkedin_public_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  company_name: string | null;
  company_url: string | null;
  company_domain: string | null;
  dripify_event_type: string;
  dripify_campaign_name: string | null;
  dripify_event_received_at: string;
  raw_webhook_payload: unknown;
}

function safeSecretCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Tolerant payload parser. Dripify's actual webhook shape is unknown at PR1
// (we're capturing it via this very endpoint), and a future Zapier intermediary
// could remap keys. So we walk a list of common name aliases and return null
// for anything missing — the raw payload is always preserved in
// raw_webhook_payload for backfill.
function firstString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function parseDripifyPayload(payload: unknown): Partial<DripifyLeadInsert> {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  const lead = (p.lead && typeof p.lead === 'object' ? p.lead : p) as Record<string, unknown>;

  return {
    linkedin_url:       firstString(lead, ['linkedin_url', 'linkedinUrl', 'profile_url', 'profileUrl', 'linkedin']),
    linkedin_public_id: firstString(lead, ['linkedin_public_id', 'public_id', 'publicId', 'linkedin_id']),
    first_name:         firstString(lead, ['first_name', 'firstName', 'first']),
    last_name:          firstString(lead, ['last_name', 'lastName', 'last']),
    full_name:          firstString(lead, ['full_name', 'fullName', 'name']),
    headline:           firstString(lead, ['headline', 'title', 'position']),
    location:           firstString(lead, ['location', 'city', 'country']),
    company_name:       firstString(lead, ['company_name', 'companyName', 'company', 'organization']),
    company_url:        firstString(lead, ['company_url', 'companyUrl', 'company_website', 'website']),
    company_domain:     firstString(lead, ['company_domain', 'domain']),
    dripify_campaign_name: firstString(p,    ['campaign_name', 'campaignName', 'campaign']),
    dripify_event_type:    firstString(p,    ['event', 'event_type', 'eventType', 'trigger', 'action']) ?? 'unknown',
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;
  const expected = process.env.DRIPIFY_WEBHOOK_SECRET;
  const signatureOk = !!expected && safeSecretCompare(secret, expected);

  // Read body and metadata. We never let JSON parse failure crash the handler —
  // the raw bytes are always written to the audit log.
  let rawText = '';
  let rawPayload: unknown = null;
  try {
    rawText = await req.text();
    rawPayload = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    rawPayload = { _parse_error: 'invalid_json', _raw_text: rawText };
  }

  const remoteIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null;
  const userAgent = req.headers.get('user-agent') ?? null;

  const supabase = createAdminClient();
  const parsed = parseDripifyPayload(rawPayload);
  const eventType = parsed.dripify_event_type ?? 'unknown';
  const campaignName = parsed.dripify_campaign_name ?? null;

  const { data: eventRow, error: eventErr } = await supabase
    .from('dripify_webhook_events')
    .insert({
      event_type: eventType,
      campaign_name: campaignName,
      raw_payload: rawPayload ?? {},
      remote_ip: remoteIp,
      user_agent: userAgent,
      signature_ok: signatureOk,
    })
    .select('id')
    .single();
  if (eventErr) {
    // Audit-log insert failure is the only thing we surface as a 500 — Dripify
    // will retry, and we genuinely need this row to debug downstream.
    return NextResponse.json({ error: 'audit_log_failed', detail: eventErr.message }, { status: 500 });
  }

  if (!signatureOk) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let dripifyLeadId: string | null = null;
  let inserted = false;
  let dedupedExisting = false;

  if (parsed.linkedin_url) {
    // Dedupe on linkedin_url. The unique partial index from migration 036
    // means a retry of the same lead lands here as a 23505; we treat that as
    // success ("we've already got them") and link the event row to the
    // existing dripify_leads row for traceability.
    const insertPayload = {
      linkedin_url: parsed.linkedin_url,
      linkedin_public_id: parsed.linkedin_public_id ?? null,
      first_name: parsed.first_name ?? null,
      last_name: parsed.last_name ?? null,
      full_name: parsed.full_name ?? null,
      headline: parsed.headline ?? null,
      location: parsed.location ?? null,
      company_name: parsed.company_name ?? null,
      company_url: parsed.company_url ?? null,
      company_domain: parsed.company_domain ?? null,
      dripify_event_type: eventType,
      dripify_campaign_name: campaignName,
      dripify_event_received_at: new Date().toISOString(),
      status: 'pending_enrich' as const,
      raw_webhook_payload: rawPayload ?? {},
    };

    const { data: leadRow, error: leadErr } = await supabase
      .from('dripify_leads')
      .insert(insertPayload)
      .select('id')
      .single();

    if (leadErr) {
      if (leadErr.code === '23505') {
        // Duplicate linkedin_url — look up the existing row so we still link
        // the audit-log entry to it.
        const { data: existing } = await supabase
          .from('dripify_leads')
          .select('id')
          .eq('linkedin_url', parsed.linkedin_url)
          .maybeSingle();
        dripifyLeadId = (existing as { id: string } | null)?.id ?? null;
        dedupedExisting = true;
      } else {
        // Unexpected DB error — log but don't 5xx (Dripify retries are
        // wasted on issues we'd see in our own logs).
        console.error('[dripify-webhook] lead insert failed', leadErr);
      }
    } else {
      dripifyLeadId = (leadRow as { id: string } | null)?.id ?? null;
      inserted = true;
    }
  }

  if (dripifyLeadId) {
    await supabase
      .from('dripify_webhook_events')
      .update({ dripify_lead_id: dripifyLeadId, processed_at: new Date().toISOString() })
      .eq('id', (eventRow as { id: string }).id);
  }

  return NextResponse.json({
    accepted: true,
    event_id: (eventRow as { id: string }).id,
    dripify_lead_id: dripifyLeadId,
    inserted,
    deduped_existing: dedupedExisting,
    parsed_linkedin_url: parsed.linkedin_url ?? null,
  });
}

// Dripify "Test" button may send a GET to probe the URL. Respond with a small
// JSON so it doesn't error out before sending a real POST.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'dripify-webhook', method: 'POST' });
}
