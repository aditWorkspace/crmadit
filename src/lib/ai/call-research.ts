import { createAdminClient } from '@/lib/supabase/admin';

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

interface CallPrepParams {
  leadId: string;
  contactName: string;
  contactEmail: string;
  contactRole?: string;
  companyName: string;
  companyUrl?: string;
  companyStage?: string;
  companySize?: string;
  callScheduledFor?: string;
}

/**
 * Generate pre-call research using Perplexity Sonar (real-time web search).
 * Updates the lead record with the research notes and status.
 */
export async function generateCallPrep(params: CallPrepParams): Promise<string> {
  const supabase = createAdminClient();

  // Mark as generating
  await supabase
    .from('leads')
    .update({ call_prep_status: 'generating' })
    .eq('id', params.leadId);

  try {
    const notes = await runPerplexityResearch(params);

    // Save to lead
    await supabase
      .from('leads')
      .update({
        call_prep_notes: notes,
        call_prep_status: 'completed',
        call_prep_generated_at: new Date().toISOString(),
      })
      .eq('id', params.leadId);

    return notes;
  } catch (err) {
    console.error(`[call-research] Failed for lead ${params.leadId}:`, err);

    await supabase
      .from('leads')
      .update({ call_prep_status: 'failed' })
      .eq('id', params.leadId);

    throw err;
  }
}

async function runPerplexityResearch(params: CallPrepParams): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not configured');
  }

  const emailDomain = params.contactEmail.split('@')[1] || '';
  const companyContext = [
    params.companyName,
    params.companyUrl ? `(${params.companyUrl})` : '',
    params.companyStage ? `Stage: ${params.companyStage}` : '',
    params.companySize ? `Size: ${params.companySize}` : '',
  ].filter(Boolean).join(' ');

  const contactContext = [
    params.contactName,
    params.contactRole ? `Role: ${params.contactRole}` : '',
    emailDomain ? `Email domain: ${emailDomain}` : '',
  ].filter(Boolean).join(', ');

  const callTime = params.callScheduledFor
    ? new Date(params.callScheduledFor).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'upcoming';

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: `You are a sales research assistant for Proxi AI, a product prioritization tool for PMs and CEOs. Generate a pre-call meeting brief for an upcoming discovery call.

Output a well-structured Markdown document with these sections:

## Company Overview
What the company does, their industry, target market, and value proposition. Be specific.

## Company Stage & Traction
Funding stage, investors, team size, notable customers, revenue signals, recent news or milestones.

## About [Contact Name]
Their role, background, likely priorities, and what they probably care about in a product prioritization tool.

## Suggested Talking Points
3-5 specific questions or discussion topics tailored to this company and contact. Focus on their likely pain points around product management, prioritization, and decision-making.

## Potential Pain Points
Based on the company type and stage, what product management challenges they likely face that Proxi AI could help with.

Keep it concise but actionable. Use bullet points. Cite specific facts when available.`,
        },
        {
          role: 'user',
          content: `Research for a discovery call (${callTime}):

Company: ${companyContext}
Contact: ${contactContext}

Generate a pre-call meeting brief.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Perplexity API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from Perplexity');
  }

  return content;
}
