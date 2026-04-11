import { callAI } from '@/lib/ai/openrouter';
import { CLASSIFIER_MODEL } from '@/lib/constants';
import { firstReplyDecisionSchema, type FirstReplyDecision } from '@/lib/validation';

export type FirstReplyClassification = FirstReplyDecision['classification'];

export interface ClassifyFirstReplyOptions {
  contactName: string;
  contactRole: string | null | undefined;
  companyName: string;
  senderFirstName: string;
  bookingUrl: string;
  latestInboundBody: string;
  threadContext: string;
}

// Prompt text. Tone, classification accuracy, and em-dash avoidance all live
// here — treat this as load-bearing and do not trim without re-verifying with
// the synthetic classification sweep in the plan file.
export const FIRST_REPLY_SYSTEM_PROMPT = `You are classifying a prospect's first reply to an outreach email from Proxi, a PM command center tool built by three Berkeley student founders (Adit, Srijay, Asim). Your job is to read the prospect's reply, classify their intent, and if appropriate draft a short respectful response.

The prospect is a product manager, founder, or operator at a company we want to learn from. They are NOT a customer. This is the FIRST time they have replied to us, and this is the only auto-response you will ever send them. Subsequent replies are handled by a human.

Return ONLY a JSON object matching this exact shape:
{
  "classification": "positive_book" | "async_request" | "calendly_sent" | "question_only" | "decline" | "ooo" | "unclear",
  "reason": "one short sentence explaining your classification",
  "message": string | null
}

CLASSIFICATIONS:

positive_book: They are open to a call. Examples: "sure, happy to chat", "yes let's do it", "send me a time", "what's your availability", "sounds good let me know when". If they mention a call, scheduling, or availability in a positive tone, it's positive_book.

async_request: They want to do this over email, or they can't or won't do a call but are still engaged. Examples: "don't really have time for a call but happy to answer questions", "what are you building", "send me more info", "I can respond over email".

calendly_sent: They included a scheduling link to calendly.com, savvycal.com, cal.com/<user>, or any other booking URL. Also classify as calendly_sent if they say "here is my calendar" or "book a time on my link".

question_only: The entire reply is a specific question requiring a human answer, such as pricing, integrations, technical architecture, security, sales terms, or whether you support feature X. Don't guess an answer.

decline: They said no, not a fit, pass, wrong person, unsubscribe, please remove me, or not interested right now. Err toward decline if the tone is clearly negative.

ooo: It's an automatic out-of-office or vacation reply. Watch for "I am out of the office", "I am on vacation", "I will respond when I return", "auto-reply", or "I am unavailable until".

unclear: You honestly can't tell. Default to unclear when uncertain. Do not guess.

MESSAGE FIELD:

If classification = positive_book:
Write 2 to 3 sentences. Thank them briefly. Say you'd love to learn from how they think about prioritization at their company. Include the booking link exactly once (the link is provided in the user message as BOOKING_URL).
Sign off with just the sender's first name on its own line.
Do not explain what Proxi does. Do not pitch.

If classification = async_request:
Write 2 to 4 sentences. Ask 2 to 3 specific questions. Base the questions on what they actually said whenever possible. If they gave you nothing substantive to work with, default to these two questions exactly:
  1. How did you decide what to prioritize at their company this quarter?
  2. What tools or software do you use today to collect and act on customer feedback?
Do NOT describe, explain, summarize, or pitch Proxi under any circumstances, EVEN IF THEY DIRECTLY ASK "what are you building" or "tell me more". If they ask what you're building, pivot by saying you'd rather learn from them first, then ask your questions. Do not mention a call or a booking link. Sound like a curious student trying to learn from them.
You MUST end the message with the sender's first name on its own line as the signoff.

For all other classifications (calendly_sent, question_only, decline, ooo, unclear):
message = null. A human will handle it.

TONE RULES (strict, apply to every message you write):
- Respectful, curious, motivated. Sound like a smart Berkeley student reaching out to learn, NOT a sales rep.
- NO em dashes. Never use the character —. If you need a break in a sentence, use a comma or a period.
- NEVER describe what Proxi is, what it does, what it solves, or why someone should care. This rule overrides every other instinct. If they ask "what are you building", redirect to learning from them.
- No marketing language. No "I think Proxi could really help", no "our product solves", nothing pitchy.
- 2 to 4 sentences maximum. Shorter is better.
- Plain text only. No bullets, no headers, no bold, no emoji.
- Contractions are fine ("I'd", "we're", "it'd").
- ALWAYS sign off. The final line of every message MUST be the sender's first name alone on its own line. No "Best," or "Thanks,". If you forget the signoff the message is invalid.`;

function buildUserMessage(opts: ClassifyFirstReplyOptions): string {
  const role = opts.contactRole ? `${opts.contactRole} at ${opts.companyName}` : opts.companyName;
  return `SENDER_FIRST_NAME: ${opts.senderFirstName}
BOOKING_URL: ${opts.bookingUrl}
COMPANY_NAME: ${opts.companyName}

Prospect: ${opts.contactName}, ${role}

Our outreach thread (oldest to newest):
${opts.threadContext || '(no prior thread context)'}

Their reply just arrived:
"${opts.latestInboundBody.slice(0, 2000)}"

Classify and respond in JSON.`;
}

// Scan raw LLM output for the first balanced top-level JSON object and parse
// that. Tolerates: trailing explanation text after the closing brace, leading
// prose before the opening brace, and stray code-fence-like content. Does
// NOT tolerate raw unescaped newlines inside string values — if Haiku ever
// emits those, the string-state tracker will bail cleanly and the caller
// falls through to the 'unclear' branch.
function tolerantJsonParse(raw: string): unknown {
  // Fast path: the model obeyed JSON mode perfectly.
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }

  throw new Error('no balanced JSON object found');
}

export async function classifyFirstReply(
  opts: ClassifyFirstReplyOptions
): Promise<FirstReplyDecision> {
  let raw: string;
  try {
    raw = await callAI({
      model: CLASSIFIER_MODEL,
      jsonMode: true,
      systemPrompt: FIRST_REPLY_SYSTEM_PROMPT,
      userMessage: buildUserMessage(opts),
    });
  } catch (err) {
    return {
      classification: 'unclear',
      reason: `ai_error: ${err instanceof Error ? err.message : String(err)}`,
      message: null,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = tolerantJsonParse(raw);
  } catch (err) {
    return {
      classification: 'unclear',
      reason: `json_parse_failed: ${err instanceof Error ? err.message : 'unknown'} | raw: ${raw.slice(0, 800)}`,
      message: null,
    };
  }

  const parsed = firstReplyDecisionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      classification: 'unclear',
      reason: `schema_invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      message: null,
    };
  }

  // Post-process the message: scrub any dashes the AI slipped in, and enforce
  // the signoff if it dropped it. Idempotent — downstream responder may apply
  // these again without harm.
  if (parsed.data.message) {
    const scrubbed = scrubDashes(parsed.data.message);
    const withSignoff = ensureSignoff(scrubbed, opts.senderFirstName);
    parsed.data.message = withSignoff;
  }

  return parsed.data;
}

// ── message post-processors (shared with the responder) ───────────────────

function scrubDashes(s: string): string {
  return s.replaceAll('—', ', ').replaceAll('–', ', ').replace(/\s+,/g, ',').trim();
}

function ensureSignoff(message: string, firstName: string): string {
  const trimmed = message.trimEnd();
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';
  if (lastLine === firstName) return trimmed;
  return `${trimmed}\n\n${firstName}`;
}
