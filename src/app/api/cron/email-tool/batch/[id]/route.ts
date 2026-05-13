// DELETE /api/cron/email-tool/batch/[id] — reverse a batch.
//
// Undoes the side effects of `runBatch` for an accidentally-generated
// sheet:
//   1) Removes the 400 picked emails from email_blacklist (matched by
//      the batch's exact created_at — every commit_batch INSERT shares
//      the txn timestamp, so the cluster is unambiguous).
//   2) Rewinds email_pool_state.next_sequence to the minimum pool
//      sequence of those emails — exactly where the pointer was BEFORE
//      the batch.
//   3) Deletes the email_batch_history row.
//   4) Clears the founder's email_batch_next_at cooldown.
//
// The Google Sheet itself is NOT trashed — keeping it around lets the
// user retrieve the recipient list if they want to redo it. The sheet
// is harmless on its own (it's just a Google Doc).
//
// Safety guards:
//   - Auth: caller must be the batch's founder OR an admin.
//   - Most-recent only: rejects if any other batch has been recorded
//     since this one — unwinding a non-tail batch would corrupt state
//     because later batches advanced the pointer past this one's range.
//   - Age cap: rejects if the batch is older than 24h. Beyond that the
//     emails may have been sent externally and reversing the blacklist
//     would risk a double-contact.
//
// Lives under /api/cron/* per project convention (Vercel deployment-
// protection HTML-404 workaround). Not actually a cron route.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const MAX_AGE_HOURS = 24;
const LOOKUP_CHUNK = 200;

interface RouteParams { params: Promise<{ id: string }> }

export async function DELETE(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const supabase = createAdminClient();

  // 1. Fetch the batch row.
  const { data: batch, error: batchErr } = await supabase
    .from('email_batch_history')
    .select('id, team_member_id, sheet_url, sheet_title, created_at')
    .eq('id', id)
    .maybeSingle();
  if (batchErr) {
    return NextResponse.json({ ok: false, reason: 'lookup_failed', detail: batchErr.message }, { status: 500 });
  }
  if (!batch) {
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 });
  }

  // 2. Auth: own batch OR admin.
  if (batch.team_member_id !== session.id && !session.is_admin) {
    return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 });
  }

  // 3. Age guard.
  const ageHours = (Date.now() - new Date(batch.created_at).getTime()) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) {
    return NextResponse.json({
      ok: false,
      reason: 'too_old',
      detail: `batch is ${ageHours.toFixed(1)}h old; reversal capped at ${MAX_AGE_HOURS}h`,
    }, { status: 409 });
  }

  // 4. Must-be-tail guard — any newer batch makes the unwind unsafe.
  const { data: laterBatches, error: laterErr } = await supabase
    .from('email_batch_history')
    .select('id, sheet_title, created_at')
    .gt('created_at', batch.created_at)
    .limit(1);
  if (laterErr) {
    return NextResponse.json({ ok: false, reason: 'tail_check_failed', detail: laterErr.message }, { status: 500 });
  }
  if (laterBatches && laterBatches.length > 0) {
    return NextResponse.json({
      ok: false,
      reason: 'not_most_recent',
      detail: `a newer batch (${laterBatches[0].sheet_title}) was created after this one; reverse that first`,
    }, { status: 409 });
  }

  // 5. Identify the blacklist cluster created in this batch's commit.
  //    The commit RPC inserts every picked email with the same now()
  //    timestamp inside one txn, so an exact equality on created_at
  //    matches the batch's emails (and only those).
  const { data: blEntries, error: blErr } = await supabase
    .from('email_blacklist')
    .select('email')
    .eq('created_at', batch.created_at);
  if (blErr) {
    return NextResponse.json({ ok: false, reason: 'cluster_lookup_failed', detail: blErr.message }, { status: 500 });
  }
  const emails = ((blEntries ?? []) as Array<{ email: string }>).map(r => r.email);
  if (emails.length === 0) {
    // Already reversed (or never had a cluster). Still wipe the history
    // row + cooldown so the user can retry, but don't touch the pointer.
    await supabase.from('email_batch_history').delete().eq('id', id);
    await supabase.from('team_members')
      .update({ email_batch_next_at: null })
      .eq('id', batch.team_member_id);
    return NextResponse.json({
      ok: true,
      reversed_emails: 0,
      restored_pointer: null,
      note: 'no blacklist cluster found — batch may have been partially reversed already',
    });
  }

  // 6. Find the MIN sequence of those emails in email_pool. That's the
  //    pointer to restore to. Chunked to stay under URL caps.
  let restorePtr: number | null = null;
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const slice = emails.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from('email_pool')
      .select('sequence')
      .in('email', slice)
      .order('sequence', { ascending: true })
      .limit(1);
    if (error) {
      return NextResponse.json({ ok: false, reason: 'pool_lookup_failed', detail: error.message }, { status: 500 });
    }
    const row = (data?.[0] as { sequence: number } | undefined);
    if (row && (restorePtr === null || row.sequence < restorePtr)) {
      restorePtr = row.sequence;
    }
  }
  if (restorePtr === null) {
    return NextResponse.json({
      ok: false,
      reason: 'no_restore_point',
      detail: 'cluster emails not found in email_pool — cannot determine where the pointer was',
    }, { status: 500 });
  }

  // 7. DELETE blacklist cluster.
  const { error: delBlErr } = await supabase
    .from('email_blacklist')
    .delete()
    .eq('created_at', batch.created_at);
  if (delBlErr) {
    return NextResponse.json({ ok: false, reason: 'blacklist_delete_failed', detail: delBlErr.message }, { status: 500 });
  }

  // 8. Restore the pointer + invalidate the cache.
  const { error: ptrErr } = await supabase
    .from('email_pool_state')
    .update({
      next_sequence: restorePtr,
      eff_remaining_seq: null,
      eff_remaining_fresh: null,
      eff_updated_at: null,
    })
    .eq('id', 1);
  if (ptrErr) {
    return NextResponse.json({
      ok: false,
      reason: 'pointer_restore_failed',
      detail: ptrErr.message,
      hint: 'blacklist cluster already deleted; set next_sequence manually to ' + restorePtr,
    }, { status: 500 });
  }

  // 9. DELETE the batch history row.
  await supabase.from('email_batch_history').delete().eq('id', id);

  // 10. Clear the founder's cooldown so they can run another batch
  //     immediately if they want.
  await supabase.from('team_members')
    .update({ email_batch_next_at: null })
    .eq('id', batch.team_member_id);

  return NextResponse.json({
    ok: true,
    reversed_emails: emails.length,
    restored_pointer: restorePtr,
    sheet_url: batch.sheet_url,
    note: 'sheet was NOT trashed — you can delete it manually in Google Drive if you want',
  });
}
