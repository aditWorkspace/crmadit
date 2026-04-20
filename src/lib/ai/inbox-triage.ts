/**
 * Inbox triage — single-call classifier that runs on every inbound email.
 *
 * Does two jobs in one Qwen call (TRIAGE_MODEL):
 *   1. Decide whether this inbound actually needs a founder response. Closing
 *      acknowledgments ("fantastic, thanks!", "locked in Wed"), OOO replies,
 *      and "no thanks" one-liners should not clutter the Needs Response tab.
 *   2. Extract any durable product/customer insight into a snippet that gets
 *      appended to the appropriate knowledge_doc (problems / product_feedback
 *      / solutions). Most emails return null here, which is fine.
 *
 * Fail-open: any error returns `{ needs_response: true, reason: 'fallback' }`
 * so we never silently hide a real reply behind a classifier hiccup.
 */

import { callAI } from './openrouter';
import { TRIAGE_MODEL } from '@/lib/constants';

export type TriageReason =
  | 'question'           // explicit question or info request — founder reply needed
  | 'scheduling'         // still negotiating a time — founder reply needed
  | 'objection'          // pushback or concern that warrants a response
  | 'other_needs_reply'  // generic catch-all when in doubt
  | 'closing_ack'        // "thanks!", "sounds good", "got it" — no reply needed
  | 'booking_confirmed'  // "locked in Wed at 10am" — just a confirmation
  | 'ooo'                // auto-reply, out of office
  | 'decline'            // "not a fit right now" — founder may want to dismiss
  | 'info_only';         // prospect shared context with no ask

export type KnowledgeDocType = 'problems' | 'product_feedback' | 'solutions';

export interface TriageResult {
  needs_response: boolean;
  reason: TriageReason;
  brief: string;                                           // one-line summary (<=120 chars)
  knowledge: { type: KnowledgeDocType; snippet: string } | null;
}

export interface TriageInput {
  inboundSubject: string;
  inboundBody: string;
  priorOutboundBody: string | null;   // most-recent outbound on the same thread (if any)
  leadStage: string | null;
  contactName: string | null;
  companyName: string | null;
}

const SYSTEM_PROMPT = `You triage inbound prospect emails for a founder-run CRM. Three founders at Proxi AI (Berkeley students building a PM command center) read their inbox and want ONLY the emails that genuinely need a reply to show up in "Needs Response."

You must return a JSON object with exactly these keys:
{
  "needs_response": boolean,
  "reason": one of ["question", "scheduling", "objection", "other_needs_reply", "closing_ack", "booking_confirmed", "ooo", "decline", "info_only"],
  "brief": string (one line, <= 120 chars, describes the email in plain English),
  "knowledge": null OR { "type": one of ["problems","product_feedback","solutions"], "snippet": string (1-2 sentences of useful insight worth remembering) }
}

Rules for needs_response:
- FALSE when the email is a closing acknowledgment ("thanks!", "sounds good", "fantastic", "appreciate it", "talk then").
- FALSE when the email just confirms a booking ("locked in Wed 3pm", "booked for tomorrow", "see you then") with no additional question.
- FALSE for out-of-office auto-replies.
- FALSE for hard declines with no opening ("not a fit right now, best of luck", "please remove me").
- FALSE when the prospect shares context but asks nothing and our prior outbound didn't ask anything either.
- TRUE for explicit questions, scheduling negotiations ("how about Friday instead?"), objections, feature asks, or anything where a thoughtful reply is expected.
- When in doubt, TRUE. It is safer to show a borderline email than to hide it.

Rules for knowledge:
- Only populate when the email contains a durable insight, NOT one-off acks or scheduling. Most emails should return null.
- "problems" — prospect describes a pain point, workflow gap, or frustration with existing tools.
- "product_feedback" — reaction to Proxi, feature request, or explicit opinion on our approach.
- "solutions" — prospect describes how they'd want to use Proxi, a workflow idea, or an integration they'd rely on.
- snippet format: 1-2 sentences that paraphrase the insight; include the company name if given.

Be strict. Return ONLY the JSON object, no prose.`;

function buildUserMessage(input: TriageInput): string {
  const stage = input.leadStage ?? 'unknown';
  const who = [input.contactName, input.companyName].filter(Boolean).join(' @ ') || 'unknown prospect';
  const priorSection = input.priorOutboundBody
    ? `\n---\nOur most recent outbound on this thread (for context):\n${input.priorOutboundBody.slice(0, 800)}\n`
    : '\n(No prior outbound on this thread — this is a cold inbound.)\n';
  return [
    `Prospect: ${who}`,
    `Lead stage: ${stage}`,
    priorSection,
    `---\nInbound email to classify:`,
    `Subject: ${input.inboundSubject}`,
    ``,
    input.inboundBody.slice(0, 2500),
  ].join('\n');
}

/**
 * Best-effort, never throws. On any failure returns a fail-open result so the
 * email still lands in Needs Response — the cost of hiding a real reply is
 * much higher than the cost of showing a thank-you.
 */
export async function triageInboundEmail(input: TriageInput): Promise<TriageResult> {
  const fallback: TriageResult = {
    needs_response: true,
    reason: 'other_needs_reply',
    brief: 'classifier fallback',
    knowledge: null,
  };

  if (!input.inboundBody || input.inboundBody.trim().length < 3) {
    return { ...fallback, brief: 'empty body' };
  }

  try {
    const raw = await callAI({
      model: TRIAGE_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: buildUserMessage(input),
      jsonMode: true,
      maxTokens: 400,
    });

    const parsed = JSON.parse(raw) as Partial<TriageResult>;
    const needs = typeof parsed.needs_response === 'boolean' ? parsed.needs_response : true;
    const reason = (parsed.reason ?? 'other_needs_reply') as TriageReason;
    const brief = typeof parsed.brief === 'string' ? parsed.brief.slice(0, 200) : '';
    const k = parsed.knowledge;
    const knowledge =
      k && typeof k === 'object' && typeof k.snippet === 'string' && k.snippet.trim().length > 0
        ? {
            type: (['problems', 'product_feedback', 'solutions'] as const).includes(
              k.type as KnowledgeDocType,
            )
              ? (k.type as KnowledgeDocType)
              : 'product_feedback',
            snippet: k.snippet.trim().slice(0, 600),
          }
        : null;

    return { needs_response: needs, reason, brief, knowledge };
  } catch (err) {
    console.error('[inbox-triage] classifier failed, falling back to needs_response=true:', err);
    return fallback;
  }
}
