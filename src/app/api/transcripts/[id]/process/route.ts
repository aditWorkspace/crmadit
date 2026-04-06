import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { processTranscript } from '@/lib/ai/transcript-processor';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();

  // Get transcript
  const { data: transcript, error: fetchError } = await supabase
    .from('transcripts')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !transcript) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!transcript.raw_text) return NextResponse.json({ error: 'No transcript text to process' }, { status: 400 });

  // Mark as processing
  await supabase
    .from('transcripts')
    .update({ processing_status: 'processing' })
    .eq('id', id);

  try {
    const analysis = await processTranscript(transcript.raw_text);

    // Save AI results
    const { error: updateError } = await supabase
      .from('transcripts')
      .update({
        ai_summary: analysis.summary,
        ai_next_steps: analysis.next_steps,
        ai_action_items: analysis.action_items,
        ai_sentiment: analysis.sentiment,
        ai_interest_level: analysis.interest_level,
        ai_key_quotes: analysis.key_quotes,
        ai_pain_points: analysis.pain_points,
        ai_product_feedback: analysis.product_feedback,
        ai_follow_up_suggestions: analysis.follow_up_suggestions,
        ai_contact_info_extracted: analysis.contact_info_extracted,
        processing_status: 'completed',
        processed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) throw new Error(updateError.message);

    return NextResponse.json({ transcript: { ...transcript, ...analysis }, analysis });
  } catch (err) {
    await supabase
      .from('transcripts')
      .update({ processing_status: 'failed' })
      .eq('id', id);

    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Processing failed',
    }, { status: 500 });
  }
}
