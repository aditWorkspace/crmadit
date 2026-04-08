import { callAI } from '@/lib/ai/openrouter';
import { QWEN_FREE_MODEL } from '@/lib/constants';

export type ReplyIntent = 'interested' | 'not_interested';

/**
 * Classifies an inbound prospect reply to determine if they're genuinely
 * interested in continuing the conversation or clearly not interested.
 *
 * Returns 'not_interested' for replies that indicate:
 * - Wrong company / wrong person
 * - Explicit disinterest ("not interested", "no thanks")
 * - Hostility or complaints about outreach
 * - Requests to stop emailing / unsubscribe
 * - Generic brush-offs with no engagement
 *
 * Returns 'interested' for anything ambiguous or showing genuine engagement.
 * We default to 'interested' to avoid accidentally filtering real leads.
 */
export async function classifyReplyIntent(
  subject: string,
  body: string
): Promise<ReplyIntent> {
  // If no body to analyze, default to interested (don't filter)
  if (!body.trim()) return 'interested';

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await callAI({
        model: QWEN_FREE_MODEL,
        systemPrompt: `You classify email replies to cold outreach. Respond with ONLY a JSON object.

The outreach is from a Berkeley student startup about product prioritization software.
A prospect has replied. Determine if they are interested or not.

Reply "not_interested" if the prospect:
- Says they aren't interested / don't want to talk
- Says you have the wrong company or wrong person
- Complains about the outreach being AI-generated or mass-emailed
- Asks to stop emailing them or unsubscribe
- Gives a dismissive or hostile response with no interest in the product
- Says they don't have time or aren't the right contact with no redirect

Reply "interested" if the prospect:
- Asks questions about the product
- Wants to schedule a call or meeting
- Shares availability or suggests a time
- Asks for more information
- Gives a positive or neutral response that could lead to a conversation
- Redirects to another person (warm handoff)
- The reply is ambiguous — when in doubt, say interested

Respond with ONLY: {"intent": "interested"} or {"intent": "not_interested"}`,
        userMessage: `Subject: ${subject}\n\nReply body:\n${body.slice(0, 600)}`,
        jsonMode: true,
      });

      const parsed = JSON.parse(response);
      if (parsed.intent === 'not_interested') return 'not_interested';
      return 'interested';
    } catch (err) {
      const isRateLimit = String(err).includes('429') || String(err).includes('rate');
      if (isRateLimit && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      // If AI call fails after retries, default to interested — never silently drop a lead
      return 'interested';
    }
  }
  return 'interested';
}
