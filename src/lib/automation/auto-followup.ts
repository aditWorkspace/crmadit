import { createAdminClient } from '@/lib/supabase/admin';
import { callAI } from '@/lib/ai/openrouter';
import { sendReplyInThread } from '@/lib/gmail/send';
import { QWEN_FREE_MODEL } from '@/lib/constants';
import { aiFollowupDecisionSchema } from '@/lib/validation';

const FOLLOWUP_HOURS = 48;
const MAX_AI_CALLS_PER_RUN = 50;

// Only send auto follow-ups for leads still in early outreach stages
const AUTO_FOLLOWUP_STAGES = ['replied', 'scheduling'];

export interface AutoFollowupResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: string[];
}

interface AiFollowupDecision {
  should_send: boolean;
  reason: string;
  message: string | null;
}

async function getFollowupDecision(
  contactName: string,
  companyName: string,
  lastOutboundBody: string,
  hoursAgo: number,
  recentThread: Array<{ type: string; body: string | null; occurred_at: string }>
): Promise<AiFollowupDecision> {
  const threadContext = recentThread
    .slice(0, 4)
    .map(i => {
      const role = i.type === 'email_inbound' ? contactName : 'Me';
      return `[${role}]: ${(i.body || '').slice(0, 200)}`;
    })
    .join('\n\n');

  const raw = await callAI({
    model: QWEN_FREE_MODEL,
    jsonMode: true,
    systemPrompt: `You are a sales assistant deciding whether to send a follow-up email.

Return JSON: { "should_send": boolean, "reason": string, "message": string | null }

Rules:
- should_send = true if my last email asked a question, shared something that needs a response, or proposed next steps
- should_send = false if my last email was a natural close ("no worries", "sounds good", "talk soon", "thanks") or if following up would feel pushy/inappropriate
- If should_send = true: write a warm, 1-2 sentence follow-up in "message". Reference the context naturally. Sign off with just my first name.
- If should_send = false: message = null`,
    userMessage: `Lead: ${contactName} at ${companyName}

Recent thread (oldest first):
${threadContext}

My last email (sent ${hoursAgo}h ago):
"${lastOutboundBody.slice(0, 400)}"

Should I follow up?`,
  });

  try {
    const parsed = aiFollowupDecisionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { should_send: false, reason: `AI response validation failed: ${parsed.error.issues[0]?.message}`, message: null };
    }
    return parsed.data;
  } catch {
    return { should_send: false, reason: 'Failed to parse AI response', message: null };
  }
}

export async function runAutoFollowup(): Promise<AutoFollowupResult> {
  const result: AutoFollowupResult = { processed: 0, sent: 0, skipped: 0, errors: [] };
  const supabase = createAdminClient();

  const cutoff = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();

  // Only auto-email leads in early outreach stages — never bother scheduled/active leads
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, contact_email, owned_by, stage')
    .eq('is_archived', false)
    .in('stage', AUTO_FOLLOWUP_STAGES)
    .not('owned_by', 'is', null);

  if (!leads || leads.length === 0) return result;

  let aiCallCount = 0;
  for (const lead of leads) {
    // Bug #10 fix — rate limit AI calls per run
    if (aiCallCount >= MAX_AI_CALLS_PER_RUN) {
      result.errors.push(`Rate limited: skipped ${leads.length - result.processed} leads after ${MAX_AI_CALLS_PER_RUN} AI calls`);
      break;
    }
    result.processed++;

    try {
      const { data: recentInteractions } = await supabase
        .from('interactions')
        .select('id, type, subject, body, gmail_message_id, gmail_thread_id, occurred_at')
        .eq('lead_id', lead.id)
        .in('type', ['email_inbound', 'email_outbound'])
        .order('occurred_at', { ascending: false })
        .limit(6);

      if (!recentInteractions || recentInteractions.length === 0) continue;

      const lastInteraction = recentInteractions[0];

      if (lastInteraction.type !== 'email_outbound') continue;
      if (new Date(lastInteraction.occurred_at) > new Date(cutoff)) continue;

      const hasInbound = recentInteractions.some(i => i.type === 'email_inbound');
      if (!hasInbound) continue;

      const threadId = lastInteraction.gmail_thread_id;
      if (!threadId) continue;

      const { data: existing } = await supabase
        .from('follow_up_queue')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'auto_send')
        .eq('status', 'pending')
        .maybeSingle();
      if (existing) continue;

      const { data: member } = await supabase
        .from('team_members')
        .select('id, name, email, gmail_connected')
        .eq('id', lead.owned_by)
        .single();
      if (!member?.gmail_connected) continue;

      const hoursAgo = Math.round(
        (Date.now() - new Date(lastInteraction.occurred_at).getTime()) / (1000 * 60 * 60)
      );

      const decision = await getFollowupDecision(
        lead.contact_name,
        lead.company_name,
        lastInteraction.body || '',
        hoursAgo,
        [...recentInteractions].reverse()
      );
      aiCallCount++;

      if (!decision.should_send || !decision.message) {
        result.skipped++;
        continue;
      }

      const lastInbound = recentInteractions.find(i => i.type === 'email_inbound');
      const inReplyToMessageId = lastInbound?.gmail_message_id
        ? `<${lastInbound.gmail_message_id}@gmail.com>`
        : undefined;

      // Look up the original thread subject to preserve threading (Bug #1 fix)
      const originalSubject = recentInteractions.find(i => i.type === 'email_inbound')?.subject
        || recentInteractions[0]?.subject
        || `product prioritization at ${lead.company_name}`;
      const threadSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

      const sentMessageId = await sendReplyInThread({
        teamMemberId: member.id,
        threadId,
        to: lead.contact_email,
        subject: threadSubject,
        body: decision.message,
        inReplyToMessageId,
      });

      const now = new Date().toISOString();

      await supabase.from('interactions').insert({
        lead_id: lead.id,
        team_member_id: member.id,
        type: 'email_outbound',
        subject: threadSubject,
        body: decision.message,
        gmail_message_id: sentMessageId || undefined,
        gmail_thread_id: threadId,
        occurred_at: now,
        metadata: { auto_followup: true, ai_decision_reason: decision.reason },
      });

      await supabase.from('follow_up_queue').insert({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'auto_send',
        status: 'sent',
        due_at: now,
        sent_at: now,
        suggested_message: decision.message,
        gmail_thread_id: threadId,
      });

      await supabase
        .from('leads')
        .update({ last_contact_at: now })
        .eq('id', lead.id);

      result.sent++;
    } catch (err) {
      result.errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
