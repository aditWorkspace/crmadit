import { createAdminClient } from '@/lib/supabase/admin';

type Supa = ReturnType<typeof createAdminClient>;
const LOOKUP_CHUNK = 200;

/** Seed up to `count` new 'queued' cold_email_drafts from the next slice of
 *  email_pool (pointer order = top of the list), round-robin across active
 *  senders, skipping blacklisted / already-a-lead emails. Advances the pool
 *  pointer. Returns the number actually seeded. Mirrors draft/seed's pool-walk
 *  but targets an absolute count instead of a per-sender buffer. */
export async function seedDrafts(supabase: Supa, count: number): Promise<number> {
  if (count <= 0) return 0;

  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name, email, email_send_paused')
    .is('departed_at', null)
    .order('name', { ascending: true });
  const senders = ((foundersData ?? []) as Array<{ id: string; name: string; email: string; email_send_paused: boolean }>)
    .filter(f => !f.email_send_paused);
  if (senders.length === 0) return 0;

  const { data: stateRow } = await supabase.from('email_pool_state').select('next_sequence').eq('id', 1).maybeSingle();
  const nextSequence = (stateRow as { next_sequence: number } | null)?.next_sequence ?? 0;

  const windowSize = Math.min(2000, count * 3 + 50);
  const { data: poolData } = await supabase
    .from('email_pool')
    .select('id, sequence, company, full_name, first_name, email')
    .gte('sequence', nextSequence)
    .order('sequence', { ascending: true })
    .limit(windowSize);
  const window = (poolData ?? []) as Array<{ id: string; sequence: number; company: string | null; full_name: string | null; first_name: string | null; email: string }>;
  if (window.length === 0) return 0;

  const emails = Array.from(new Set(window.map(r => r.email.toLowerCase())));
  const blacklisted = new Set<string>();
  const isLead = new Set<string>();
  const alreadySent = new Set<string>();
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const slice = emails.slice(i, i + LOOKUP_CHUNK);
    const { data: bl } = await supabase.from('email_blacklist').select('email').in('email', slice);
    for (const r of (bl ?? []) as Array<{ email: string }>) blacklisted.add(r.email.toLowerCase());
    const { data: leads } = await supabase.from('leads').select('contact_email').in('contact_email', slice);
    for (const r of (leads ?? []) as Array<{ contact_email: string }>) if (r.contact_email) isLead.add(r.contact_email.toLowerCase());
    // Never email anyone we've already sent to in any prior campaign. The
    // blacklist/leads checks miss non-repliers (they never became leads), so
    // this closes the duplicate-send gap when a freshly-uploaded lead overlaps
    // the send history.
    const { data: sent } = await supabase.from('email_send_queue').select('recipient_email').in('recipient_email', slice);
    for (const r of (sent ?? []) as Array<{ recipient_email: string }>) if (r.recipient_email) alreadySent.add(r.recipient_email.toLowerCase());
  }

  const senderIds = senders.map(s => s.id);
  let rr = 0;
  const inserts: Array<Record<string, unknown>> = [];
  let lastSeq = nextSequence - 1;
  let taken = 0;
  for (const row of window) {
    if (taken >= count) break;
    lastSeq = row.sequence;
    const e = row.email.toLowerCase();
    if (blacklisted.has(e) || isLead.has(e) || alreadySent.has(e)) continue;
    const sid = senderIds[rr % senderIds.length];
    rr++;
    const sender = senders.find(s => s.id === sid)!;
    inserts.push({
      pool_id: row.id, sender_account_id: sid, email: e,
      first_name: row.first_name, full_name: row.full_name, company: row.company,
      domain: e.split('@')[1] ?? null, sender_name: sender.name, sender_email: sender.email, status: 'queued',
    });
    taken++;
  }

  let seeded = 0;
  if (inserts.length) {
    const { count: c } = await supabase
      .from('cold_email_drafts')
      .upsert(inserts, { onConflict: 'pool_id,sender_account_id', ignoreDuplicates: true, count: 'exact' });
    seeded = c ?? inserts.length;
  }
  if (lastSeq >= nextSequence) {
    await supabase.from('email_pool_state')
      .update({ next_sequence: lastSeq + 1, eff_remaining_seq: null, eff_remaining_fresh: null, eff_updated_at: null })
      .eq('id', 1);
  }
  return seeded;
}
