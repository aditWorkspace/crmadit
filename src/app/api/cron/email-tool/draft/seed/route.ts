// POST /api/cron/email-tool/draft/seed — admin only.
//
// Keeps each active sender's personalized-draft buffer topped up. Reads the
// next un-consumed slice of email_pool (via the existing email_pool_state
// pointer — the legacy fresh pool-pick is superseded by this draft pipeline),
// assigns each lead to exactly ONE sender (round-robin, respecting per-sender
// deficits), and inserts `queued` cold_email_drafts with ON CONFLICT DO
// NOTHING. The draft worker researches + writes them; runDailyStart only ever
// sends `ready` ones.
//
// Idempotent: re-running before the worker drains does nothing new (the
// pointer has advanced and UNIQUE(pool_id, sender_account_id) + ON CONFLICT
// guard against dupes).
export const maxDuration = 60;
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { DRAFT_BUFFER_TARGET_PER_SENDER } from '@/lib/email-tool/cold-constants';

const ACTIVE_DRAFT_STATUSES = ['queued', 'researching', 'verifying_evidence', 'writing', 'checking', 'ready'];
const MAX_SEED_PER_RUN = 600;
const LOOKUP_CHUNK = 200;

interface PoolRow {
  id: string;
  sequence: number;
  company: string | null;
  full_name: string | null;
  first_name: string | null;
  email: string;
}

export async function POST(req: NextRequest) {
  // Callable two ways: cron-job.org (CRON_SECRET bearer) for the scheduled
  // buffer top-up, or an admin session for a manual trigger.
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const supabase = createAdminClient();

  // ── Active senders + per-sender deficit ────────────────────────────────────
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name, email, email_send_paused')
    .is('departed_at', null)
    .order('name', { ascending: true });
  const senders = ((foundersData ?? []) as Array<{ id: string; name: string; email: string; email_send_paused: boolean }>)
    .filter(f => !f.email_send_paused);
  if (senders.length === 0) return NextResponse.json({ ok: true, note: 'no_active_senders', seeded: 0 });

  const deficit = new Map<string, number>();
  for (const s of senders) {
    const { count } = await supabase
      .from('cold_email_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('sender_account_id', s.id)
      .in('status', ACTIVE_DRAFT_STATUSES);
    deficit.set(s.id, Math.max(0, DRAFT_BUFFER_TARGET_PER_SENDER - (count ?? 0)));
  }
  let totalToSeed = Math.min(MAX_SEED_PER_RUN, [...deficit.values()].reduce((a, b) => a + b, 0));
  if (totalToSeed === 0) return NextResponse.json({ ok: true, note: 'buffers_full', seeded: 0 });

  // ── Pull the next slice of pool rows from the pointer ──────────────────────
  const { data: stateRow } = await supabase
    .from('email_pool_state').select('next_sequence').eq('id', 1).maybeSingle();
  const nextSequence = (stateRow as { next_sequence: number } | null)?.next_sequence ?? 0;

  const windowSize = Math.min(2000, totalToSeed * 3);
  const { data: poolData } = await supabase
    .from('email_pool')
    .select('id, sequence, company, full_name, first_name, email')
    .gte('sequence', nextSequence)
    .order('sequence', { ascending: true })
    .limit(windowSize);
  const window = (poolData ?? []) as PoolRow[];
  if (window.length === 0) return NextResponse.json({ ok: true, note: 'pool_exhausted', seeded: 0 });

  // Membership sets for the window: blacklist + existing CRM leads (don't
  // research a lead we already can't / shouldn't email).
  const emails = Array.from(new Set(window.map(r => r.email.toLowerCase())));
  const blacklisted = new Set<string>();
  const isLead = new Set<string>();
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const slice = emails.slice(i, i + LOOKUP_CHUNK);
    const { data: bl } = await supabase.from('email_blacklist').select('email').in('email', slice);
    for (const r of (bl ?? []) as Array<{ email: string }>) blacklisted.add(r.email.toLowerCase());
    const { data: leads } = await supabase.from('leads').select('contact_email').in('contact_email', slice);
    for (const r of (leads ?? []) as Array<{ contact_email: string }>) isLead.add(r.contact_email.toLowerCase());
  }

  // ── Walk the window in sequence order, assigning to senders by deficit ─────
  const remaining = new Map(deficit);
  const senderIds = senders.map(s => s.id);
  let rr = 0;
  const inserts: Array<Record<string, unknown>> = [];
  let lastHandledSeq = nextSequence - 1;

  const pickSender = (): string | null => {
    for (let n = 0; n < senderIds.length; n++) {
      const id = senderIds[(rr + n) % senderIds.length];
      if ((remaining.get(id) ?? 0) > 0) { rr = (rr + n + 1) % senderIds.length; return id; }
    }
    return null;
  };

  for (const row of window) {
    if (totalToSeed <= 0) break; // deficits filled — stop before consuming more
    lastHandledSeq = row.sequence;
    const emailLc = row.email.toLowerCase();
    if (blacklisted.has(emailLc) || isLead.has(emailLc)) continue; // consume (pointer advances) but don't seed
    const senderId = pickSender();
    if (!senderId) break;
    const sender = senders.find(s => s.id === senderId)!;
    inserts.push({
      pool_id: row.id,
      sender_account_id: senderId,
      email: emailLc,
      first_name: row.first_name,
      full_name: row.full_name,
      company: row.company,
      domain: emailLc.split('@')[1] ?? null,
      sender_name: sender.name,
      sender_email: sender.email,
      status: 'queued',
    });
    remaining.set(senderId, (remaining.get(senderId) ?? 0) - 1);
    totalToSeed--;
  }

  // ── Insert (ON CONFLICT DO NOTHING via the UNIQUE constraint) ──────────────
  let seeded = 0;
  if (inserts.length > 0) {
    const { error, count } = await supabase
      .from('cold_email_drafts')
      .upsert(inserts, { onConflict: 'pool_id,sender_account_id', ignoreDuplicates: true, count: 'exact' });
    if (error) return NextResponse.json({ error: 'insert_failed', detail: error.message }, { status: 500 });
    seeded = count ?? inserts.length;
  }

  // Advance the pool pointer past everything we consumed this run.
  if (lastHandledSeq >= nextSequence) {
    await supabase.from('email_pool_state')
      .update({ next_sequence: lastHandledSeq + 1, eff_remaining_seq: null, eff_remaining_fresh: null, eff_updated_at: null })
      .eq('id', 1);
  }

  return NextResponse.json({
    ok: true,
    seeded,
    considered: window.length,
    advanced_pointer_to: lastHandledSeq + 1,
    per_sender_deficit: Object.fromEntries(deficit),
  });
}
