// Orchestrator for one batch request.
//
// Order:
//   1) RPC email_tool_pick_batch  — read-only SELECT against pool, anti-joined
//                                    against blacklist, ordered by sequence
//                                    LIMIT 400. No DB writes here.
//   2) createBatchSheet           — Google Sheets/Drive side effect. Outside
//                                    any DB transaction; if it throws we
//                                    return early WITHOUT advancing pointer
//                                    or blacklisting anything.
//   3) RPC email_tool_commit_batch — atomic txn: blacklist insert, history
//                                    insert, pointer advance, cooldown set,
//                                    cache refresh. PL/pgSQL function gives
//                                    us all-or-nothing semantics.

import { createAdminClient } from '@/lib/supabase/admin';
import { createBatchSheet, describeGoogleError, type PickedRow } from './sheets';
import { BATCH_SIZE, COOLDOWN_HOURS } from './constants';

export type RunBatchOutcome =
  | { ok: true; url: string; title: string; nextAvailableAt: string; freshRemaining: number; picked: number }
  | { ok: false; reason: 'cooldown'; retryAt: string }
  | { ok: false; reason: 'exhausted'; remaining: number }
  | { ok: false; reason: 'sheet_error'; detail: string }
  | { ok: false; reason: 'unknown'; detail: string };

export async function runBatch(args: {
  teamMemberId: string;
  teamMemberName: string;
  teamMemberEmail: string;
  cooldownAt: string | null | undefined;
}): Promise<RunBatchOutcome> {
  const now = new Date();

  if (args.cooldownAt && new Date(args.cooldownAt) > now) {
    return { ok: false, reason: 'cooldown', retryAt: args.cooldownAt };
  }

  const supabase = createAdminClient();

  // 1) Pick.
  const { data: rows, error: pickErr } = await supabase
    .rpc('email_tool_pick_batch', { p_limit: BATCH_SIZE });
  if (pickErr) return { ok: false, reason: 'unknown', detail: pickErr.message };

  const picked = (rows ?? []) as Array<PickedRow & { sequence: number }>;
  if (picked.length < BATCH_SIZE) {
    return { ok: false, reason: 'exhausted', remaining: picked.length };
  }

  // 2) Sheet creation. Side effect; any throw bails before any DB write.
  let url: string;
  let title: string;
  try {
    const r = await createBatchSheet({
      userName: args.teamMemberName,
      userEmail: args.teamMemberEmail,
      rows: picked.map(p => ({
        company: p.company,
        full_name: p.full_name,
        email: p.email,
        first_name: p.first_name,
      })),
    });
    url = r.url;
    title = r.title;
  } catch (err) {
    return { ok: false, reason: 'sheet_error', detail: describeGoogleError(err) };
  }

  // 3) Atomic commit via the PL/pgSQL function.
  const maxSeq = picked.reduce((m, p) => Math.max(m, p.sequence), -1);
  const emails = picked.map(p => p.email);

  const { data: commitData, error: commitErr } = await supabase
    .rpc('email_tool_commit_batch', {
      p_team_member_id: args.teamMemberId,
      p_picked_emails:  emails,
      p_max_sequence:   maxSeq,
      p_sheet_url:      url,
      p_sheet_title:    title,
      p_cooldown_hours: COOLDOWN_HOURS,
    });

  if (commitErr) {
    // Sheet already exists in Drive but the commit failed. Without a
    // transaction wrapping the side effect itself, the safest move is
    // to surface the error — operator can manually advance the pointer
    // and add the emails to blacklist via the dashboard / direct SQL.
    return {
      ok: false,
      reason: 'unknown',
      detail: `commit failed AFTER sheet creation. Sheet URL: ${url}. Error: ${commitErr.message}`,
    };
  }

  const result = commitData as { next_sequence: number; cooldown_at: string; fresh_remaining: number };
  return {
    ok: true,
    url,
    title,
    nextAvailableAt: result.cooldown_at,
    freshRemaining: result.fresh_remaining,
    picked: picked.length,
  };
}

export async function getFreshRemaining(): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('email_tool_fresh_remaining');
  if (error || data == null) return 0;
  return data as number;
}

export async function addToBlacklistFromUpload(emails: string[]): Promise<{
  newlyAdded: number;
  totalAfter: number;
  freshRemaining: number;
  uniqueInput: number;
}> {
  const supabase = createAdminClient();
  const unique = Array.from(new Set(
    emails
      .map(e => (e ?? '').trim().toLowerCase())
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  ));

  // Count before insert so we can report the actual newly-inserted delta.
  const { count: before } = await supabase
    .from('email_blacklist')
    .select('*', { count: 'exact', head: true });

  if (unique.length === 0) {
    return {
      newlyAdded: 0,
      totalAfter: before ?? 0,
      freshRemaining: await getFreshRemaining(),
      uniqueInput: 0,
    };
  }

  // Bulk insert with ON CONFLICT DO NOTHING (the unique constraint handles
  // dedup; we use upsert with ignoreDuplicates=true to get that semantics
  // from the JS client).
  const CHUNK = 1000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK).map(email => ({ email }));
    const { error } = await supabase
      .from('email_blacklist')
      .upsert(slice, { onConflict: 'email', ignoreDuplicates: true });
    if (error) throw new Error(`blacklist chunk ${i / CHUNK + 1} failed: ${error.message}`);
  }

  const { count: after } = await supabase
    .from('email_blacklist')
    .select('*', { count: 'exact', head: true });

  return {
    newlyAdded: (after ?? 0) - (before ?? 0),
    totalAfter: after ?? 0,
    freshRemaining: await getFreshRemaining(),
    uniqueInput: unique.length,
  };
}
