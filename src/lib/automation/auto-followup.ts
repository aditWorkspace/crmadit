import { createAdminClient } from '@/lib/supabase/admin';
import { callAI } from '@/lib/ai/openrouter';
import { WRITER_MODEL } from '@/lib/constants';
import { aiFollowupDecisionSchema } from '@/lib/validation';
import { canSendOutbound, hasMinimumGap, pickRandomSendTime } from './send-guards';
import { formatEmailBody } from '@/lib/format/email-body';

function firstNameOf(fullName: string | null | undefined, fallback = 'there'): string {
  if (!fullName) return fallback;
  const trimmed = fullName.trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0];
}

const FOLLOWUP_HOURS = 48;
const MAX_AI_CALLS_PER_RUN = 50;

// Narrowed to 'scheduling' only: the 'replied' stage is now owned by the
// first-reply auto-responder in first-reply-responder.ts.
const AUTO_FOLLOWUP_STAGES = ['scheduling'];

export interface AutoFollowupResult {
  processed: number;
  queued: number;
  skipped: number;
  skipped_reasons: Record<string, number>;
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
    model: WRITER_MODEL,
    jsonMode: true,
    systemPrompt: `You are a sales assistant deciding whether to send a follow-up email.

Return JSON: { "should_send": boolean, "reason": string, "message": string | null }

Rules:
- should_send = true if my last email asked a question, shared something that needs a response, or proposed next steps
- should_send = false if my last email was a natural close ("no worries", "sounds good", "talk soon", "thanks") or if following up would feel pushy/inappropriate
- If should_send = true: write a warm, 1-2 sentence follow-up in "message". Reference the context naturally.
- If should_send = false: message = null
- NEVER use em dashes (the — character). Use commas or periods instead. This rule is absolute.
- NEVER describe, explain, or pitch what Proxi does. Sound like a curious student, not a salesperson.
- No filler phrases ("I hope this finds you well", "Just following up", "Just wanted to check in")
- End the message body with a clear next step or question
- After the message body, add a signoff on two separate lines: "Best," then the sender's first name on the next line
- Output ONLY the email body text in the "message" field. No subject line, no "Dear X"`,
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

/**
 * Evaluates leads in 'scheduling' stage and queues follow-up emails for
 * delivery at a random time during business hours. Does NOT send directly.
 * Actual sending is handled by drainScheduledEmails() in the cron route.
 */
export async function runAutoFollowup(): Promise<AutoFollowupResult> {
  const result: AutoFollowupResult = {
    processed: 0,
    queued: 0,
    skipped: 0,
    skipped_reasons: {},
    errors: [],
  };
  const supabase = createAdminClient();

  const cutoff = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();

  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, contact_email, owned_by, stage')
    .eq('is_archived', false)
    .in('stage', AUTO_FOLLOWUP_STAGES)
    .not('owned_by', 'is', null);

  if (!leads || leads.length === 0) return result;

  let aiCallCount = 0;
  for (const lead of leads) {
    if (aiCallCount >= MAX_AI_CALLS_PER_RUN) {
      result.errors.push(`Rate limited: skipped ${leads.length - result.processed} leads after ${MAX_AI_CALLS_PER_RUN} AI calls`);
      break;
    }
    result.processed++;

    try {
      // Guard: max consecutive outbound
      const allowed = await canSendOutbound(lead.id);
      if (!allowed) {
        result.skipped++;
        result.skipped_reasons['max_consecutive_outbound'] = (result.skipped_reasons['max_consecutive_outbound'] || 0) + 1;
        continue;
      }

      // Guard: minimum 48h gap
      const gapOk = await hasMinimumGap(lead.id);
      if (!gapOk) {
        result.skipped++;
        result.skipped_reasons['min_gap_not_met'] = (result.skipped_reasons['min_gap_not_met'] || 0) + 1;
        continue;
      }

      // Guard: don't queue if there's already a pending auto-send for this lead
      const { data: existing } = await supabase
        .from('follow_up_queue')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('auto_send', true)
        .eq('status', 'pending')
        .maybeSingle();
      if (existing) {
        result.skipped++;
        result.skipped_reasons['already_queued'] = (result.skipped_reasons['already_queued'] || 0) + 1;
        continue;
      }

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

      // Post-process via shared formatter: canonical greeting + spacing + signoff
      const scrubbed = formatEmailBody(decision.message, {
        recipientFirstName: firstNameOf(lead.contact_name, 'there'),
        senderFirstName: firstNameOf(member.name, 'Adit'),
      });

      // Queue for delivery at a random business-hours time
      const sendAt = pickRandomSendTime();

      await supabase.from('follow_up_queue').insert({
        lead_id: lead.id,
        assigned_to: lead.owned_by,
        type: 'auto_send',
        status: 'pending',
        auto_send: true,
        due_at: sendAt.toISOString(),
        scheduled_for: sendAt.toISOString(),
        suggested_message: scrubbed,
        gmail_thread_id: threadId,
        reason: decision.reason,
      });

      result.queued++;
    } catch (err) {
      result.errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
