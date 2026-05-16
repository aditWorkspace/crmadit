// GET /api/cron/email-tool/pool-preview — admin-only peek at the next
// N rows the daily cron would pull. Backed by the existing read-only
// RPC email_tool_pick_batch (defined in 019_email_tool_rpcs.sql),
// which already does the "WHERE sequence >= next_sequence AND NOT IN
// blacklist ORDER BY sequence" query.
//
// No state changes. Safe to call as often as you want.
//
// Lives under /api/cron/* per project convention (Vercel deployment-
// protection HTML-404 workaround).
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!session.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.max(1, Math.min(isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT));

  const supabase = createAdminClient();

  // Use the same RPC the daily cron uses — guarantees "what you see
  // here is what the next batch would actually pull".
  const { data, error } = await supabase.rpc('email_tool_pick_batch', { p_limit: limit });
  if (error) {
    return NextResponse.json({ error: 'rpc_failed', detail: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<{
    id: string; sequence: number;
    company: string | null; full_name: string | null;
    email: string; first_name: string | null;
  }>;

  // Surface pool_state too so the page can show pointer + remaining.
  const [{ data: state }, { data: freshRem }] = await Promise.all([
    supabase.from('email_pool_state').select('next_sequence, eff_remaining_fresh, eff_remaining_seq').eq('id', 1).maybeSingle(),
    supabase.rpc('email_tool_fresh_remaining'),
  ]);

  return NextResponse.json({
    rows,
    next_sequence: (state as { next_sequence: number } | null)?.next_sequence ?? null,
    fresh_remaining: (freshRem ?? null) as number | null,
    limit,
  });
}

// PATCH /api/cron/email-tool/pool-preview — inline edits from the pool
// preview UI. Updates a single email_pool row by id with whichever of
// {first_name, company, email} the client sends. Validates types but
// not content — this is a trusted admin-only console.
//
// Body: { id: string, first_name?: string|null, company?: string|null, email?: string }
export async function PATCH(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let body: { id?: string; first_name?: string | null; company?: string | null; email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: 'id_required' }, { status: 400 });

  const patch: Record<string, string | null> = {};
  if ('first_name' in body) patch.first_name = body.first_name ?? null;
  if ('company' in body) patch.company = body.company ?? null;
  if ('email' in body && typeof body.email === 'string') {
    patch.email = body.email.toLowerCase().trim();
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error: upErr } = await supabase
    .from('email_pool')
    .update(patch)
    .eq('id', body.id);
  if (upErr) {
    return NextResponse.json({ error: 'update_failed', detail: upErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: body.id, patched: patch });
}
