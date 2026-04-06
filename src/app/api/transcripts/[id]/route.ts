import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { changeStage } from '@/lib/automation/stage-logic';
import { addDays } from '@/lib/utils';

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

  const body = await req.json();
  const {
    summary, next_steps, sentiment, interest_level,
    action_items, follow_up_suggestions, apply_to_lead,
  } = body;

  const supabase = createAdminClient();

  // Get transcript to find lead_id
  const { data: transcript } = await supabase.from('transcripts').select('lead_id').eq('id', id).single();
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
    } catch (err) {
      return NextResponse.json({
        error: 'Failed to apply transcript to lead',
        details: err instanceof Error ? err.message : String(err),
      }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
