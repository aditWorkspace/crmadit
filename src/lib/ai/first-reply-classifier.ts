import { callAI } from '@/lib/ai/openrouter';
import { DECIDER_MODEL } from '@/lib/constants';
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

// Pure classifier. Emits an intent label + one-line content plan for the
// writer. Never writes prose — first-reply-writer.ts handles that on Haiku.
// Tone, classification accuracy, and the info_request/question_only split
// live here. Treat as load-bearing.
export const FIRST_REPLY_SYSTEM_PROMPT = `You are classifying a prospect's first reply to an outreach email from Proxi, a PM command center tool built by three Berkeley student founders (Adit, Srijay, Asim).

The prospect is a product manager, founder, or operator at a company we want to learn from. They are NOT a customer. This is the FIRST time they have replied to us.

Return ONLY a JSON object:
{
  "classification": "positive_book" | "async_request" | "info_request" | "calendly_sent" | "question_only" | "decline" | "ooo" | "unclear",
  "reason": "one short sentence explaining your classification",
  "content_plan": string | null,
  "message": null
}

Always set "message" to null. A separate writer module composes the prose from "content_plan".

CLASSIFICATIONS:

positive_book: They are open to a call. Examples: "sure, happy to chat", "yes let's do it", "send me a time", "what's your availability", "sounds good let me know when". Mentioning a call, scheduling, or availability in a positive tone counts.

async_request: They want to handle this over email or explicitly decline a call while staying engaged. Examples: "don't really have time for a call but happy to answer questions", "send me more info", "I can respond over email".

info_request: They asked a LIGHT product-curiosity question that can be answered briefly without a human. Examples: "what is Proxi", "tell me more", "are you funded", "is it AI-based", "where are you based", "what does it do", "one-liner please", "who's on the team". These questions are answerable from a small reference Q&A without inventing details. If you are confident we can answer in 1-2 sentences without bluffing on specifics, choose info_request.

calendly_sent: They included a scheduling link (calendly.com, savvycal.com, cal.com/<user>, any other booking URL) OR said "here is my calendar" / "book a time on my link". A human should log in and book the slot.

question_only: A SPECIFIC question requiring a human answer: pricing details, concrete integrations list, security/compliance (SOC 2, GDPR, data residency), technical architecture, SSO/SAML, sales terms, or whether you support feature X. Err on the side of question_only when the answer requires commitment or concrete spec we cannot guess at.

decline: No, not a fit, pass, wrong person, unsubscribe, please remove me, not interested. Err toward decline if tone is clearly negative.

ooo: Automatic out-of-office / vacation reply. Watch for "I am out of the office", "I am on vacation", "auto-reply", "I will return on".

unclear: You honestly cannot tell. Default here when uncertain. Do not guess.

CONTENT_PLAN FIELD:

For positive_book / async_request / info_request: a ONE-sentence plan telling the writer what to cover. Examples:
- "thank them, acknowledge interest in learning from their prioritization process, include the booking link"
- "they prefer email; ask how they prioritized this quarter and what feedback tool they use"
- "they asked what Proxi does; answer briefly that it's a PM command center, pivot by asking how they handle prioritization today"

For calendly_sent / question_only / decline / ooo / unclear: content_plan = null.

RULES:
- Do NOT write any prose in "message". It is always null.
- Do NOT include em dashes, em-dash equivalents, or any forbidden marketing words in content_plan (keep it short).
- Return pure JSON. No markdown fences, no explanation outside the object.`;

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
// NOT tolerate raw unescaped newlines inside string values — if the model ever
// emits those, the string-state tracker will bail cleanly and the caller
// falls through to the 'unclear' branch.
function tolerantJsonParse(raw: string): unknown {
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
      model: DECIDER_MODEL,
      jsonMode: true,
      systemPrompt: FIRST_REPLY_SYSTEM_PROMPT,
      userMessage: buildUserMessage(opts),
    });
  } catch (err) {
    return {
      classification: 'unclear',
      reason: `ai_error: ${err instanceof Error ? err.message : String(err)}`,
      message: null,
      content_plan: null,
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
      content_plan: null,
    };
  }

  const parsed = firstReplyDecisionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      classification: 'unclear',
      reason: `schema_invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      message: null,
      content_plan: null,
    };
  }

  // Force message to null — prose comes from the writer module now. If a
  // legacy deploy or a retry path ever reads stale classifier output with
  // message populated, we ignore it deliberately.
  parsed.data.message = null;
  return parsed.data;
}
