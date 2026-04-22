import { createAdminClient } from '@/lib/supabase/admin';
import { processTranscript } from '@/lib/ai/transcript-processor';
import { appendToKnowledgeDocs } from '@/lib/ai/knowledge-doc-updater';
import { changeStage } from '@/lib/automation/stage-logic';
import { addDays } from '@/lib/utils';
import { format } from 'date-fns';
import { LeadStage } from '@/types';

export interface ProcessResult {
  success: boolean;
  transcriptId: string;
  error?: string;
}

/**
 * Unified function to process a transcript with AI and auto-apply results to lead.
 * Designed for background/fire-and-forget execution after upload.
 *
 * Steps:
 * 1. Fetch transcript + lead info from DB
 * 2. Call AI to analyze transcript
 * 3. Save AI results to transcript record
 * 4. Auto-apply to lead: update call_summary/next_steps, create action_items, create follow_ups
 * 5. Auto-advance stage to call_completed if in pre-call stage
 * 6. Log interaction and activity
 * 7. Update knowledge docs
 */
export async function processAndApplyTranscript(transcriptId: string): Promise<ProcessResult> {
  const supabase = createAdminClient();

  // 1. Get transcript with lead info
  const { data: transcript, error: fetchError } = await supabase
    .from('transcripts')
    .select('*, leads(id, contact_name, company_name, stage, owned_by)')
    .eq('id', transcriptId)
    .single();

  if (fetchError || !transcript) {
    return { success: false, transcriptId, error: 'Transcript not found' };
  }

  if (!transcript.raw_text) {
    await supabase.from('transcripts').update({ processing_status: 'failed' }).eq('id', transcriptId);
    return { success: false, transcriptId, error: 'No transcript text' };
  }

  // Mark as processing
  await supabase.from('transcripts').update({ processing_status: 'processing' }).eq('id', transcriptId);

  try {
    // 2. AI analysis
    const analysis = await processTranscript(transcript.raw_text);

    // 3. Save AI results to transcript
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
    if (updateError) {
      throw new Error(`Failed to save AI results: ${updateError.message}`);
    }

    // 4. Auto-apply to lead
    const leadId = transcript.lead_id;
    const lead = transcript.leads;

    if (!lead) {
      console.warn(`[process-transcript] Transcript ${transcriptId} has no associated lead`);
      return { success: true, transcriptId };
    }

    // Run independent mutations in parallel
    await Promise.all([
      // Update lead with call summary and next steps
      supabase.from('leads').update({
        call_summary: analysis.summary,
        next_steps: analysis.next_steps,
        updated_at: new Date().toISOString(),
      }).eq('id', leadId),

      // Insert action items (map AI field names to DB field names)
      analysis.action_items?.length
        ? supabase.from('action_items').insert(
            analysis.action_items.map(item => ({
              lead_id: leadId,
              text: item.text,
              assigned_to: item.suggested_assignee,
              due_date: item.suggested_due_date || null,
              source: 'ai_extracted',
            }))
          )
        : Promise.resolve(),

      // Create follow-ups from suggestions
      analysis.follow_up_suggestions?.length
        ? supabase.from('follow_up_queue').insert(
            analysis.follow_up_suggestions.map(s => ({
              lead_id: leadId,
              assigned_to: lead.owned_by || null,
              type: 'check_in',
              reason: s.action,
              suggested_message: s.reason,
              due_at: addDays(new Date(), 1).toISOString(),
              status: 'pending',
            }))
          )
        : Promise.resolve(),

      // Log interaction
      supabase.from('interactions').insert({
        lead_id: leadId,
        team_member_id: lead.owned_by || null,
        type: 'call',
        subject: 'Call transcript auto-processed',
        body: analysis.summary,
        occurred_at: new Date().toISOString(),
      }),

      // Log activity
      supabase.from('activity_log').insert({
        lead_id: leadId,
        team_member_id: lead.owned_by || null,
        action: 'transcript_auto_applied',
        details: {
          transcript_id: transcriptId,
          action_items_count: analysis.action_items?.length || 0,
          follow_ups_count: analysis.follow_up_suggestions?.length || 0,
        },
      }),
    ]);

    // 5. Auto-advance to call_completed if in pre-call stage
    const preCallStages: LeadStage[] = ['replied', 'scheduling', 'scheduled'];
    if (preCallStages.includes(lead.stage)) {
      // Use lead owner as the actor for background processing
      const actorId = lead.owned_by;
      if (actorId) {
        await changeStage(leadId, 'call_completed', actorId);
      }
    }

    // 7. Update knowledge docs
    if (lead.contact_name && lead.company_name) {
      try {
        await appendToKnowledgeDocs({
          leadName: lead.contact_name,
          companyName: lead.company_name,
          date: format(new Date(), 'yyyy-MM-dd'),
          painPoints: analysis.pain_points || [],
          productFeedback: analysis.product_feedback || [],
          keyQuotes: analysis.key_quotes || [],
          followUpSuggestions: analysis.follow_up_suggestions || [],
        });
      } catch (kdErr) {
        console.error('[knowledge-docs] Failed to update:', kdErr);
        // Non-fatal — transcript processing still succeeded
      }
    }

    return { success: true, transcriptId };
  } catch (err) {
    console.error(`[process-transcript] Failed for ${transcriptId}:`, err);
    await supabase.from('transcripts').update({ processing_status: 'failed' }).eq('id', transcriptId);
    return { success: false, transcriptId, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
