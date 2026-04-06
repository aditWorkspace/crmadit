import { callAI } from './openrouter';
import { Lead } from '@/types';

export async function draftFollowUp(lead: Lead, lastInteractionSummary: string, daysSince: number): Promise<string> {
  const systemPrompt = `You're drafting a follow-up email for a startup founder. Keep it casual, brief (2-3 sentences), and human. No corporate speak. Match the founder's voice — they're a Berkeley student, direct and unpretentious. Return just the email body, no subject line.`;

  const userMessage = `Context:
- Lead: ${lead.contact_name} at ${lead.company_name} (${lead.contact_role || 'unknown role'})
- Current stage: ${lead.stage}
- Last interaction: ${lastInteractionSummary}
- Days since last contact: ${daysSince}
- Key context: ${lead.call_notes || lead.call_summary || 'No notes'}`;

  return callAI({ systemPrompt, userMessage });
}
