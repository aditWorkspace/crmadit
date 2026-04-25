// Diagnostic-only: take a transcript ID, run processTranscript directly,
// return the actual error message instead of swallowing it. Used to debug
// the 7 stubbornly-failing Granola backfill transcripts.
//
// Usage: POST /api/cron/granola-debug-process?id=<uuid>
//        Authorization: Bearer $CRON_SECRET
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronAuth } from '@/lib/auth/cron';
import { createAdminClient } from '@/lib/supabase/admin';
import { processTranscript } from '@/lib/ai/transcript-processor';

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing ?id=<uuid>' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: t, error } = await supabase
    .from('transcripts')
    .select('id, raw_text, leads(contact_name, company_name)')
    .eq('id', id)
    .single();

  if (error || !t) return NextResponse.json({ error: error?.message || 'not found' }, { status: 404 });
  if (!t.raw_text) return NextResponse.json({ error: 'no raw_text' });

  const lead = t.leads as unknown as { contact_name?: string; company_name?: string } | null;

  try {
    const analysis = await processTranscript(t.raw_text);
    return NextResponse.json({
      ok: true,
      lead: `${lead?.contact_name} @ ${lead?.company_name}`,
      raw_text_length: t.raw_text.length,
      summary_preview: analysis.summary?.slice(0, 200),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      lead: `${lead?.contact_name} @ ${lead?.company_name}`,
      raw_text_length: t.raw_text.length,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5) : undefined,
    });
  }
}

export { handler as GET, handler as POST };
