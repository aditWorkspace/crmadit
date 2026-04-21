import { callAI } from '@/lib/ai/openrouter';
import { DECIDER_MODEL } from '@/lib/constants';
import { firstReplyDecisionSchema, type FirstReplyDecision, type FirstReplyCategory } from '@/lib/validation';

export type FirstReplyClassification = FirstReplyCategory;

export interface ClassifyFirstReplyOptions {
  contactName: string;
  contactRole: string | null | undefined;
  companyName: string;
  senderFirstName: string;
  bookingUrl: string;
  latestInboundBody: string;
  threadContext: string;
}

// 25-category classifier. Emits category + extracted metadata (dates, referrals).
// Writer module handles prose generation separately on Haiku.
export const FIRST_REPLY_SYSTEM_PROMPT = `You are classifying a prospect's reply to an outreach email from Proxi, a PM command center built by three Berkeley students (Adit, Srijay, Asim).

Return ONLY a JSON object:
{
  "category": "<one of 25 categories below>",
  "reason": "1-sentence explanation",
  "follow_up_date": "YYYY-MM-DD" or null,
  "referral_name": "string" or null,
  "referral_email": "string" or null
}

CATEGORIES (pick the BEST match):

GROUP A - POSITIVE (auto-reply with booking link):
- positive_enthusiastic: Excited agreement ("Yes! Would love to!", "Absolutely!", "That sounds great!")
- positive_casual: Casual agreement ("Sure, happy to chat", "Yeah I'm open", "Works for me")
- positive_send_times: Asks for availability ("Send me some times", "What works for you?", "When are you free?")
- positive_specific_day: Mentions specific day ("How about next Tuesday?", "Thursday works", "Maybe sometime next week?")

GROUP B - ASYNC/EMAIL (auto-reply without call push):
- async_prefer_email: Explicitly prefers email over call ("No time for a call but happy to answer over email", "Let's keep this async")
- async_send_info: Wants more info first ("Send me more info", "Tell me more", "What exactly are you building?")
- async_busy: Too busy, just email ("Super busy, just email me what you need", "Slammed right now")

GROUP C - INFO REQUEST (auto-reply with Q&A answer):
- info_what_is_it: Asks what Proxi is ("What is Proxi?", "What are you building?", "What does your tool do?")
- info_team: Asks about team ("Who are you guys?", "What's your background?", "Tell me about the team")
- info_funding: Asks about funding ("Are you funded?", "Do you have investors?", "Self-funded?")
- info_general: Other light questions ("How does it work?", "Is it AI?", "How is this different?")

GROUP D - DELAY (schedule follow-up, brief ack):
- delay_specific_date: Mentions specific date ("Follow up after Feb 15th", "Reach back in March", "Let's talk after the 20th")
- delay_after_event: After some event ("Once our product launch is done", "After Q1 planning", "When we close this round")
- delay_traveling: Currently traveling ("I'm traveling until the 20th", "Back in office next Monday", "On vacation until...")
- delay_generic: Vague delay ("Not a good time", "Circle back later", "Maybe in a few weeks", "Reach out again soon")
- delay_ooo: Out-of-office auto-reply (detect "I am out of the office", "I will return on", auto-responder patterns)

GROUP E - REFERRAL (ask for contact info):
- referral_named: Names someone else ("Talk to Sarah Chen", "CC'ing my colleague Mike", "You should reach out to our PM lead")
- referral_unknown: Says wrong person without naming alternative ("I'm not the right person", "Try someone else on the team")

GROUP F - DECLINE (NO auto-reply):
- decline_polite: Polite rejection ("Thanks but not a fit right now", "Appreciate it but no", "Not what we need")
- decline_firm: Firm rejection ("Not interested", "Please don't contact me again", "Stop emailing me")
- decline_unsubscribe: Explicit unsubscribe ("Unsubscribe", "Remove me from your list", "Take me off")

GROUP G - MANUAL REVIEW:
- calendly_sent: Sent a scheduling link (calendly.com, cal.com, savvycal.com, any booking URL)
- question_compliance: Compliance question (SOC 2, GDPR, data residency, HIPAA, security audit)
- question_technical: Technical question (specific integrations, API, architecture, data format)
- question_pricing: Pricing question (cost, pricing model, free tier, enterprise pricing)

FALLBACK:
- unclear: Cannot determine intent, ambiguous, or doesn't fit any category

RULES:
1. For delay_* categories: ALWAYS populate follow_up_date with best guess in YYYY-MM-DD format
   - "next month" → 1st of next month
   - "after Feb 15th" → 2026-02-16
   - "in a few weeks" → 3 weeks from today
   - "after Q1" → 2026-04-01
   - OOO with "back Jan 10" → 2026-01-11
2. For referral_named: Extract the name, and email if provided in the message
3. decline_* categories should NEVER trigger an auto-reply
4. When in doubt between categories, pick the one that requires LESS automation (safer)
5. Return pure JSON only. No markdown fences, no explanation outside the object.`;

function buildUserMessage(opts: ClassifyFirstReplyOptions): string {
  const role = opts.contactRole ? `${opts.contactRole} at ${opts.companyName}` : opts.companyName;
  const today = new Date().toISOString().split('T')[0];
  return `TODAY'S DATE: ${today}
SENDER_FIRST_NAME: ${opts.senderFirstName}
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
      category: 'unclear',
      reason: `ai_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = tolerantJsonParse(raw);
  } catch (err) {
    return {
      category: 'unclear',
      reason: `json_parse_failed: ${err instanceof Error ? err.message : 'unknown'} | raw: ${raw.slice(0, 800)}`,
    };
  }

  const parsed = firstReplyDecisionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      category: 'unclear',
      reason: `schema_invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }

  return parsed.data;
}
