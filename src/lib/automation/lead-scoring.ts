import { callAI } from '@/lib/ai/openrouter';
import { createAdminClient } from '@/lib/supabase/admin';
import { QWEN_FREE_MODEL } from '@/lib/constants';

export async function scoreAndSuggestForLead(leadId: string): Promise<void> {
  const supabase = createAdminClient();

  const [{ data: lead }, { data: interactions }] = await Promise.all([
    supabase
      .from('leads')
      .select('id, contact_name, company_name, stage, priority, heat_score, last_contact_at, call_notes, next_steps, tags')
      .eq('id', leadId)
      .single(),
    supabase
      .from('interactions')
      .select('type, subject, body, summary, occurred_at')
      .eq('lead_id', leadId)
      .order('occurred_at', { ascending: false })
      .limit(5),
  ]);

  if (!lead) return;

  const interactionSummary = (interactions || []).map(i =>
    `[${i.type}] ${i.subject || '(no subject)'}: ${(i.summary || i.body || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `You are analyzing a CRM lead for Proxi AI (a product prioritization SaaS for PMs).

Lead: ${lead.contact_name} at ${lead.company_name}
Stage: ${lead.stage} | Current Priority: ${lead.priority} | Heat: ${lead.heat_score}/100
Last contact: ${lead.last_contact_at ? new Date(lead.last_contact_at).toLocaleDateString() : 'unknown'}
Call notes: ${lead.call_notes || 'none'}
Recent interactions:
${interactionSummary || 'none'}

Return JSON:
{
  "heat_score": <0-100, how hot/interested this lead is>,
  "heat_reason": "<1 sentence why>",
  "next_action": "<specific, actionable next step — 1 sentence, direct and concrete>",
  "next_action_urgency": "<high|medium|low>"
}`;

  try {
    const raw = await callAI({
      model: QWEN_FREE_MODEL,
      systemPrompt: 'You are a CRM assistant. Analyze leads and suggest next actions. Always return valid JSON with no markdown fencing.',
      userMessage: prompt,
      // Free Qwen models don't support json_object response_format — parse manually
    });

    // Extract JSON from the response (handles cases where model wraps in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const result = JSON.parse(jsonMatch[0]);
    const heat = Math.min(100, Math.max(0, Number(result.heat_score) || lead.heat_score));

    await supabase
      .from('leads')
      .update({
        heat_score: heat,
        ai_heat_reason: result.heat_reason || null,
        ai_next_action: result.next_action || null,
        ai_next_action_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId);
  } catch (err) {
    // Re-throw so callers can surface the error
    throw err;
  }
}

export async function runBulkScoring(): Promise<{ scored: number; errors: number }> {
  const supabase = createAdminClient();

  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .eq('is_archived', false)
    .not('stage', 'in', '("dead","paused")')
    .order('last_contact_at', { ascending: false })
    .limit(50);

  let scored = 0;
  let errors = 0;

  for (const lead of leads || []) {
    try {
      await scoreAndSuggestForLead(lead.id);
      scored++;
    } catch {
      errors++;
    }
    // Small delay to avoid rate limits on free tier
    await new Promise(r => setTimeout(r, 200));
  }

  return { scored, errors };
}
