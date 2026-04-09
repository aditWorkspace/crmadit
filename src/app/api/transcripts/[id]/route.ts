import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { changeStage } from '@/lib/automation/stage-logic';
import { addDays } from '@/lib/utils';
import { appendToKnowledgeDocs } from '@/lib/ai/knowledge-doc-updater';
import { format } from 'date-fns';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();
  const { data, error } = await supabase.from('transcripts').select('*').eq('id', id).single();
  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ transcript: data });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  let knowledgeDocsUpdated = false;
  const body = await req.json();
  const {
    summary, next_steps, sentiment, interest_level,
    action_items, follow_up_suggestions, apply_to_lead,
  } = body;

  const supabase = createAdminClient();

  // Get transcript to find lead_id + AI fields for knowledge doc updates
  const { data: transcript } = await supabase.from('transcripts')
    .select('lead_id, ai_pain_points, ai_product_feedback, ai_key_quotes, ai_follow_up_suggestions')
    .eq('id', id).single();
  if (!transcript) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Update transcript with reviewed AI results
  await supabase.from('transcripts').update({
    ai_summary: summary,
    ai_next_steps: next_steps,
    ai_sentiment: sentiment,
    ai_interest_level: interest_level,
    ai_action_items: action_items,
  }).eq('id', id);

  if (apply_to_lead) {
    try {
      const leadId = transcript.lead_id;

      // Update lead with call summary and next steps
      await supabase.from('leads').update({
        call_summary: summary,
        next_steps,
        updated_at: new Date().toISOString(),
      }).eq('id', leadId);

      // Insert action items
      if (action_items?.length) {
        await supabase.from('action_items').insert(
          action_items.map((item: { text: string; assigned_to?: string; due_date?: string; urgency?: string }) => ({
            lead_id: leadId,
            text: item.text,
            assigned_to: item.assigned_to || null,
            due_date: item.due_date || null,
            source: 'ai_extracted',
          }))
        );
      }

      // Create follow-ups from suggestions
      if (follow_up_suggestions?.length) {
        const { data: lead } = await supabase.from('leads').select('owned_by').eq('id', leadId).single();
        await supabase.from('follow_up_queue').insert(
          follow_up_suggestions.map((s: { action: string; timing: string; reason: string }) => ({
            lead_id: leadId,
            assigned_to: lead?.owned_by || null,
            type: 'check_in',
            reason: s.action,
            suggested_message: s.reason,
            due_at: addDays(new Date(), 1).toISOString(),
            status: 'pending',
          }))
        );
      }

      // Auto-advance to call_completed if not already past that
      const { data: currentLead } = await supabase.from('leads').select('stage').eq('id', leadId).single();
      const preCallStages = ['replied', 'scheduling', 'scheduled'];
      if (currentLead && preCallStages.includes(currentLead.stage)) {
        await changeStage(leadId, 'call_completed', session.id);
      }

      // Log interaction of type 'call'
      await supabase.from('interactions').insert({
        lead_id: leadId,
        team_member_id: session.id,
        type: 'call',
        subject: 'Call transcript uploaded and processed',
        body: summary,
        occurred_at: new Date().toISOString(),
      });

      // Log activity
      await supabase.from('activity_log').insert({
        lead_id: leadId,
        team_member_id: session.id,
        action: 'transcript_applied',
        details: {
          action_items_count: action_items?.length || 0,
          follow_ups_count: follow_up_suggestions?.length || 0,
        },
      });

      // Update knowledge docs (synchronous — guarantees docs stay fresh)
      try {
        const { data: leadInfo } = await supabase.from('leads')
          .select('contact_name, company_name')
          .eq('id', leadId).single();

        if (leadInfo) {
          await appendToKnowledgeDocs({
            leadName: leadInfo.contact_name,
            companyName: leadInfo.company_name,
            date: format(new Date(), 'yyyy-MM-dd'),
            painPoints: transcript.ai_pain_points || [],
            productFeedback: transcript.ai_product_feedback || [],
            keyQuotes: transcript.ai_key_quotes || [],
            followUpSuggestions: transcript.ai_follow_up_suggestions || [],
          });
          knowledgeDocsUpdated = true;
        }
      } catch (kdErr) {
        console.error('[knowledge-docs] Failed to update:', kdErr);
        // Non-fatal — lead update still succeeded
      }
    } catch (err) {
      return NextResponse.json({
        error: 'Failed to apply transcript to lead',
        details: err instanceof Error ? err.message : String(err),
      }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true, knowledge_docs_updated: knowledgeDocsUpdated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const supabase = createAdminClient();

  // Delete any Supabase Storage file associated with this transcript
  const { data: transcript } = await supabase.from('transcripts').select('file_path').eq('id', id).single();
  if (!transcript) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (transcript.file_path) {
    await supabase.storage.from('transcripts').remove([transcript.file_path]);
  }

  const { error } = await supabase.from('transcripts').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
