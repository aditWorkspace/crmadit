// Advisor / misc transcripts. POST to upload, GET to list.
//
// Lives under /api/cron/* because Vercel's deployment-protection layer
// HTML-404s authenticated POSTs to most other /api/* paths (same reason
// the other recent endpoints sit here). Auth is session-cookie, not
// CRON_SECRET.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { processAdvisorTranscript } from '@/lib/automation/process-advisor-transcript';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('transcripts')
    .select('id, kind, participant_name, participant_context, raw_text, ai_summary, ai_sentiment, ai_interest_level, processing_status, created_at')
    .in('kind', ['advisor_call', 'misc'])
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ transcripts: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { participant_name, participant_context, raw_text, kind } = body as {
    participant_name?: string;
    participant_context?: string;
    raw_text?: string;
    kind?: 'advisor_call' | 'misc';
  };

  if (!participant_name?.trim()) return NextResponse.json({ error: 'participant_name required' }, { status: 400 });
  if (!raw_text?.trim()) return NextResponse.json({ error: 'raw_text required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: inserted, error } = await supabase
    .from('transcripts')
    .insert({
      lead_id: null,
      kind: kind === 'misc' ? 'misc' : 'advisor_call',
      participant_name: participant_name.trim(),
      participant_context: participant_context?.trim() || null,
      source_type: 'paste',
      raw_text,
      processing_status: 'pending',
    })
    .select('id, kind, participant_name, participant_context, processing_status, created_at')
    .single();

  if (error || !inserted) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 });

  // Fire-and-forget AI processing (long-running; we don't want to block
  // the upload response on it).
  processAdvisorTranscript(inserted.id).catch(err => {
    console.error(`[advisor-upload] processAdvisorTranscript failed for ${inserted.id}:`, err);
  });

  return NextResponse.json({ transcript: inserted });
}
