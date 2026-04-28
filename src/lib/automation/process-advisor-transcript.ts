// Variant of process-and-apply-transcript for advisor / misc calls.
//
// Same AI summary + structured-fields extraction (so the insights chat
// can search and cite quotes the same way it does for customer calls)
// — but skips the lead-update phase (no lead) and the knowledge-doc
// aggregation (those tracks customer feedback only; advisor opinions
// shouldn't pollute the customer pain-points / problem-themes docs).

import { createAdminClient } from '@/lib/supabase/admin';
import { processTranscript } from '@/lib/ai/transcript-processor';

export interface ProcessResult {
  success: boolean;
  transcriptId: string;
  error?: string;
}

export async function processAdvisorTranscript(transcriptId: string): Promise<ProcessResult> {
  const supabase = createAdminClient();

  const { data: transcript, error: fetchError } = await supabase
    .from('transcripts')
    .select('*')
    .eq('id', transcriptId)
    .single();

  if (fetchError || !transcript) {
    return { success: false, transcriptId, error: fetchError?.message ?? 'transcript not found' };
  }

  if (!transcript.raw_text) {
    await supabase.from('transcripts').update({ processing_status: 'failed' }).eq('id', transcriptId);
    return { success: false, transcriptId, error: 'no transcript text' };
  }

  await supabase.from('transcripts').update({ processing_status: 'processing' }).eq('id', transcriptId);

  try {
    const analysis = await processTranscript(transcript.raw_text);
    const { error: updateError } = await supabase.from('transcripts').update({
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
    }).eq('id', transcriptId);
    if (updateError) throw new Error(updateError.message);
    return { success: true, transcriptId };
  } catch (err) {
    console.error(`[process-advisor-transcript] failed for ${transcriptId}:`, err);
    await supabase.from('transcripts').update({ processing_status: 'failed' }).eq('id', transcriptId);
    return { success: false, transcriptId, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
