import { createAdminClient } from '@/lib/supabase/admin';
import { listAllNotes, getNoteWithTranscript, transcriptItemsToText, type GranolaNoteSummary } from './client';
import { matchNoteToLead, type MatchConfidence } from './matcher';
import { processAndApplyTranscript } from '@/lib/automation/process-and-apply-transcript';

// Two founders, two API keys. The label is what we use in granola_sync_state
// and as the source attribution on the imported transcript.
export interface GranolaKey {
  label: string;       // 'adit' | 'srijay'
  apiKey: string;
}

export function loadGranolaKeys(): GranolaKey[] {
  const out: GranolaKey[] = [];
  if (process.env.GRANOLA_API_KEY_ADIT) out.push({ label: 'adit', apiKey: process.env.GRANOLA_API_KEY_ADIT });
  if (process.env.GRANOLA_API_KEY_SRIJAY) out.push({ label: 'srijay', apiKey: process.env.GRANOLA_API_KEY_SRIJAY });
  return out;
}

export interface SyncResult {
  api_key_label: string;
  scanned: number;
  imported: number;
  skipped_no_match: number;
  skipped_dup: number;
  skipped_low_confidence: number;
  errors: number;
  match_log: Array<{
    note_id: string;
    note_title: string | null;
    note_created_at: string;
    decision: 'imported' | 'dup' | 'no_match' | 'error';
    confidence?: MatchConfidence;
    lead?: string;
    reason?: string;
  }>;
}

export interface SyncOptions {
  // 'incremental' uses last_synced_at from granola_sync_state (default).
  // 'backfill' walks the entire feed regardless of cursor.
  mode?: 'incremental' | 'backfill';
  // Only import strong/medium matches by default. Set to true to allow weak.
  acceptWeakMatches?: boolean;
  // Hard cap on notes processed in one sync — keeps cron functions under
  // their time budget.
  maxNotes?: number;
}

export async function syncOneKey(key: GranolaKey, options: SyncOptions = {}): Promise<SyncResult> {
  const { mode = 'incremental', acceptWeakMatches = false, maxNotes = 500 } = options;
  const supabase = createAdminClient();

  // Pull cursor. In `incremental` mode we use a fixed 48h lookback rather
  // than the historic last_synced_at because:
  //   1) Granola's /v1/notes only returns notes that already have a
  //      transcript. A note created at 19:30 may not appear in the list
  //      until ~20:30 once Granola finishes processing.
  //   2) If a sync run advances last_synced_at to 20:00 between those
  //      points, the note (created_at 19:30) is permanently behind the
  //      cursor and never imported.
  //   3) granola_note_id is a unique index, so re-scanning the same
  //      window across runs is cheap and safe — duplicates are no-ops.
  // 48h is plenty: even a meeting that was rescheduled by a day still
  // gets caught.
  let createdAfter: string | undefined;
  if (mode === 'incremental') {
    createdAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  }

  const result: SyncResult = {
    api_key_label: key.label,
    scanned: 0,
    imported: 0,
    skipped_no_match: 0,
    skipped_dup: 0,
    skipped_low_confidence: 0,
    errors: 0,
    match_log: [],
  };

  let mostRecentCreatedAt: string | undefined;
  let lastError: string | null = null;

  try {
    for await (const note of listAllNotes({ apiKey: key.apiKey, createdAfter })) {
      if (result.scanned >= maxNotes) break;
      result.scanned++;
      mostRecentCreatedAt = !mostRecentCreatedAt || note.created_at > mostRecentCreatedAt
        ? note.created_at
        : mostRecentCreatedAt;

      try {
        const decision = await processOneNote(note, key, acceptWeakMatches);
        result.match_log.push(decision);
        if (decision.decision === 'imported') result.imported++;
        else if (decision.decision === 'dup') result.skipped_dup++;
        else if (decision.decision === 'no_match') {
          if (decision.confidence === 'weak') result.skipped_low_confidence++;
          else result.skipped_no_match++;
        }
      } catch (err) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        result.match_log.push({
          note_id: note.id,
          note_title: note.title,
          note_created_at: note.created_at,
          decision: 'error',
          reason: msg,
        });
        lastError = msg;
      }
    }
  } catch (err) {
    result.errors++;
    lastError = err instanceof Error ? err.message : String(err);
  }

  // Update sync state. Even on partial failure we advance the cursor to the
  // newest successfully-scanned note, so we don't re-paginate forever.
  await supabase
    .from('granola_sync_state')
    .update({
      last_synced_at: mostRecentCreatedAt ?? new Date().toISOString(),
      last_run_at: new Date().toISOString(),
      last_error: lastError,
      notes_imported: result.imported,
      notes_skipped: result.skipped_no_match + result.skipped_dup + result.skipped_low_confidence,
    })
    .eq('api_key_label', key.label);

  return result;
}

async function processOneNote(
  note: GranolaNoteSummary,
  key: GranolaKey,
  acceptWeakMatches: boolean,
): Promise<SyncResult['match_log'][number]> {
  const supabase = createAdminClient();

  // Step 1: dup check by note_id (fastest, covers the same-key case).
  const { data: existing } = await supabase
    .from('transcripts')
    .select('id')
    .eq('granola_note_id', note.id)
    .maybeSingle();
  if (existing) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'dup', reason: 'granola_note_id already present' };
  }

  // Step 2: title + time match.
  const match = await matchNoteToLead(note.title, note.created_at);
  if (!match) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'no_match', reason: 'no lead matched title' };
  }
  if (match.confidence === 'weak' && !acceptWeakMatches) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'no_match', confidence: 'weak', lead: `${match.contact_name} @ ${match.company_name}`, reason: match.reason };
  }

  // Step 3: cross-key dedup. If we already imported a transcript for this
  // lead within ±48h, the other founder's note already covered this call.
  const noteTime = new Date(note.created_at);
  const lo = new Date(noteTime.getTime() - 48 * 3600 * 1000).toISOString();
  const hi = new Date(noteTime.getTime() + 48 * 3600 * 1000).toISOString();
  const { data: nearby } = await supabase
    .from('transcripts')
    .select('id, granola_note_id')
    .eq('lead_id', match.lead_id)
    .gte('created_at', lo)
    .lte('created_at', hi)
    .limit(1);
  if (nearby?.length) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'dup', confidence: match.confidence, lead: `${match.contact_name} @ ${match.company_name}`, reason: 'lead has a transcript within ±48h already' };
  }

  // Step 4: pull full note + transcript.
  const full = await getNoteWithTranscript(note.id, key.apiKey);
  if (!full?.transcript?.length) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'no_match', reason: 'note has no transcript yet (Granola may still be processing)' };
  }
  const rawText = transcriptItemsToText(full.transcript);
  if (!rawText.trim()) {
    return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'no_match', reason: 'transcript empty after flatten' };
  }

  // Step 5: insert transcript row + kick off AI processing in background.
  const granolaUrl = `https://app.granola.ai/notes/${note.id}`;
  const { data: inserted, error } = await supabase
    .from('transcripts')
    .insert({
      lead_id: match.lead_id,
      source_type: 'granola_link',
      granola_url: granolaUrl,
      granola_note_id: note.id,
      raw_text: rawText,
      processing_status: 'pending',
      created_at: note.created_at,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    // Could be a unique-violation race if both keys process the same note
    // in parallel — treat as dup, not error.
    if (error?.code === '23505') {
      return { note_id: note.id, note_title: note.title, note_created_at: note.created_at, decision: 'dup', reason: 'race: another sync inserted first' };
    }
    throw new Error(error?.message || 'transcript insert failed');
  }

  // Fire-and-forget AI processing. Long, expensive, runs in background.
  processAndApplyTranscript(inserted.id).catch(err => {
    console.error(`[granola-sync] processAndApplyTranscript failed for ${inserted.id}:`, err);
  });

  return {
    note_id: note.id,
    note_title: note.title,
    note_created_at: note.created_at,
    decision: 'imported',
    confidence: match.confidence,
    lead: `${match.contact_name} @ ${match.company_name}`,
    reason: match.reason,
  };
}

export async function syncAllKeys(options: SyncOptions = {}): Promise<SyncResult[]> {
  const keys = loadGranolaKeys();
  const results: SyncResult[] = [];
  // Sequential rather than parallel — both keys hit the same API and we'd
  // rather not double our rate-limit footprint.
  for (const key of keys) {
    results.push(await syncOneKey(key, options));
  }
  return results;
}
