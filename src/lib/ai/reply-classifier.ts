/**
 * Stage 2: AI Classifier (Haiku)
 *
 * Detailed categorization with 40+ categories.
 * Returns primary + secondary categories and embedded questions.
 */

import { callAI } from './openrouter';
import { WRITER_MODEL } from '@/lib/constants';

export interface ClassifierInput {
  contactName: string;
  companyName: string;
  latestInboundSubject: string;
  latestInboundBody: string;
  threadContext: string; // Recent thread history
}

export interface ClassifierResult {
  primary_category: string;
  secondary_categories: string[];
  sub_category: string;
  confidence: number;
  flags: string[];
  embedded_questions: string[];
  extracted: {
    proposed_date: string | null;
    referral_name: string | null;
    referral_email: string | null;
    return_date: string | null;
  };
}

const CLASSIFIER_PROMPT = `You are classifying a prospect's email reply to cold outreach about product prioritization.

IMPORTANT: Use the EXACT sub-category values from the list below (lowercase with underscores).

OUTPUT JSON ONLY:
{
  "primary_category": "positive_casual",
  "secondary_categories": ["info_how_found"],
  "sub_category": "positive_casual",
  "confidence": 0.92,
  "flags": ["contains_question"],
  "embedded_questions": ["how did you find us"],
  "extracted": {
    "proposed_date": null,
    "referral_name": null,
    "referral_email": null,
    "return_date": null
  }
}

## MULTI-CATEGORY HANDLING

Replies often contain MULTIPLE intents. Use the SPECIFIC sub-category values:
- "Yes let's chat, how did you find us?" → primary_category: "positive_casual", secondary_categories: ["info_how_found"]
- "Sure, but what exactly do you do?" → primary_category: "positive_casual", secondary_categories: ["info_what_is_it"]
- "I'm traveling until March, but yes interested" → primary_category: "delay_traveling", secondary_categories: ["positive_casual"]
- "Talk to Sarah, she handles this" → primary_category: "referral_named", secondary_categories: []
- "I'd rather do this over email if that's ok. What did you want to discuss?" → primary_category: "async_prefer_email", secondary_categories: ["async_quick_questions"]
- "Can you send more info first? Want to see if relevant" → primary_category: "async_send_info", secondary_categories: []
- "Too busy for calls but happy to chat over email. What's on your mind?" → primary_category: "async_busy_no_call", secondary_categories: ["async_quick_questions"]
- "Why are you reaching out to me specifically?" → primary_category: "info_why_me", secondary_categories: []
- "Are you guys looking for a job or something?" → primary_category: "edge_resume", secondary_categories: []
- "Is this some kind of sales pitch?" → primary_category: "edge_skeptical", secondary_categories: []
- "Is this for a class project or something?" → primary_category: "info_what_is_it", secondary_categories: []
- "lol sure why not" → primary_category: "positive_casual", secondary_categories: []
- "Go Bears! Happy to help a fellow student" → primary_category: "positive_enthusiastic", secondary_categories: []
- "Sure, send me some times" → primary_category: "positive_send_times", secondary_categories: []

The writer will receive ALL categories and must address each one in the response.

## MAIN CATEGORIES & SUB-CATEGORIES

### POSITIVE (wants to talk)
- positive_enthusiastic: "Yes! Would love to chat", "Absolutely, let's do it", "Yeah for sure!", "Go Bears! Happy to help a fellow student"
- positive_casual: "Sure", "Yeah I'm down", "Happy to chat", "Sure thing", "lol sure why not", "haha yeah fine", "ok yeah lets do it"
- positive_send_times: "Send me some times", "What's your availability", "when works for you", "send over some times"
- positive_specific_day: "How about Tuesday", "Next Thursday works"
- positive_calendly_request: "Do you have a Calendly", "Send booking link"

IMPORTANT: Even sarcastic or casual positive responses like "lol sure why not" or "haha ok fine" are POSITIVE, not edge cases. The person is agreeing.

### ASYNC (prefers email)
- async_prefer_email: "I'd rather do this over email"
- async_send_info: "Can you send more info first", "Can you send me some info?", "Send me more details first", "What specifically did you want to discuss?"
- async_busy_no_call: "Too busy for calls, but happy to email"
- async_quick_questions: "Just have a couple quick questions"

### INFO_REQUEST (asking about us)
- info_what_is_it: "What is Proxi", "What are you building", "Is this for a class project?", "Is this a school thing?"
- info_how_found: "How did you find me", "How did you come across us"
- info_team: "Who are you", "Tell me about your team"
- info_funding: "Are you funded", "Who are your investors"
- info_stage: "How far along are you", "Do you have users"
- info_why_me: "Why are you reaching out to me specifically"

NOTE: "Is this for a class project?" is NOT edge_academic. It's info_what_is_it - they're asking what we're doing. We're students but NOT doing this for a class - we're building a real product.

### DELAY (not now, later)
- delay_specific_date: "Reach out after March 15" (extract date)
- delay_next_quarter: "After Q2", "Next quarter"
- delay_after_event: "After our launch", "After this sprint"
- delay_traveling: "I'm traveling until X" (extract return date)
- delay_busy_generic: "Swamped right now", "Maybe in a few weeks"
- delay_ooo: Out of office with return date

### DECLINE (not interested)
- decline_polite: "Not a fit right now", "I'll pass"
- decline_firm: "Not interested", "No"
- decline_unsubscribe: "Remove me", "Stop emailing"
- decline_wrong_person: "I don't do product work"

### REFERRAL (pointing to someone else)
- referral_named: "Talk to Sarah instead" (extract name/email)
- referral_will_connect: "Let me connect you with..."
- referral_unknown: "Not the right person, but someone else might be"

### QUESTION (needs founder input)
- question_compliance: SOC2, GDPR, HIPAA, security, privacy
- question_technical: APIs, integrations, Jira, Slack, technical details
- question_pricing: Cost, pricing, payment, enterprise
- question_legal: Terms, contracts, NDA, legal review
- question_data: Data handling, storage, retention, deletion

### CALENDLY_SENT (prospect sent their link)
- calendly_sent: Contains Calendly, Cal.com, SavvyCal, Acuity, Doodle link

### EDGE_CASE (DO NOT AUTO-REPLY - route to founder)
- edge_resume: "Here's my resume", "Looking for work", "Are you hiring?", "Are you guys looking for a job?"
- edge_linkedin: "Connect on LinkedIn", "Add me on LinkedIn"
- edge_sales_pitch: Someone pitching US a product/service
- edge_partnership: Partnership, collaboration, cross-promotion
- edge_investment: "Can I invest", "Looking for deal flow"
- edge_press: Media inquiry, interview request, podcast
- edge_academic: Research study, survey, thesis
- edge_contact_request: "What's your phone number", "Direct email"
- edge_spam: Clearly automated/spam
- edge_hostile: Angry, threatening, hostile tone
- edge_sarcastic: Sarcastic, dismissive, mocking ("lol whatever", "ok I guess")
- edge_skeptical: "Is this a sales pitch?", "Is this spam?", "Are you trying to sell me something?"
- edge_one_word: Just "ok", "sure", "maybe", "thanks" with no context
- edge_random: Completely off-topic, makes no sense
- edge_competitor: Mentions they work at a competitor
- edge_already_using: "We already use X for this"

## FLAGS (can have multiple)
- contains_question: Reply contains a question we should answer
- mentions_timeline: Mentions a specific date or timeframe
- mentions_person: Mentions another person by name
- skeptical_tone: Sounds skeptical or cautious
- enthusiastic_tone: Sounds excited or eager
- formal_tone: Very formal/corporate language
- casual_tone: Very casual/friendly language
- short_reply: Less than 20 words
- long_reply: More than 100 words

## CONFIDENCE SCORING
- 0.95+: Textbook match, zero ambiguity
- 0.85-0.94: Clear match with minor noise
- 0.70-0.84: Likely this category but could be another
- <0.70: Uncertain, should go to founder

## EMBEDDED QUESTIONS
Extract any questions the prospect asked that need answering:
- "how did you find us" / "how did you come across"
- "what are you building" / "what is proxi"
- "who are you" / "tell me about your team"
- "are you funded"
- etc.
`;

function buildUserMessage(opts: ClassifierInput): string {
  return `Prospect: ${opts.contactName} at ${opts.companyName}

Recent thread (oldest first):
${opts.threadContext || '(no prior thread context)'}

Latest inbound reply:
Subject: ${opts.latestInboundSubject}
Body: "${opts.latestInboundBody}"

Classify this reply.`;
}

export async function classifyReply(opts: ClassifierInput): Promise<ClassifierResult> {
  const response = await callAI({
    model: WRITER_MODEL,
    systemPrompt: CLASSIFIER_PROMPT,
    userMessage: buildUserMessage(opts),
    jsonMode: true,
    maxTokens: 800,
  });

  try {
    // Extract just the JSON object (model sometimes adds text after)
    let jsonStr = response;
    const firstBrace = response.indexOf('{');
    const lastBrace = response.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = response.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);
    return {
      primary_category: parsed.primary_category || 'edge_random',
      secondary_categories: parsed.secondary_categories || [],
      sub_category: parsed.sub_category || '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      flags: parsed.flags || [],
      embedded_questions: parsed.embedded_questions || [],
      extracted: {
        proposed_date: parsed.extracted?.proposed_date || null,
        referral_name: parsed.extracted?.referral_name || null,
        referral_email: parsed.extracted?.referral_email || null,
        return_date: parsed.extracted?.return_date || null,
      },
    };
  } catch {
    // Parse error - treat as edge case
    return {
      primary_category: 'edge_random',
      secondary_categories: [],
      sub_category: 'parse_error',
      confidence: 0,
      flags: [],
      embedded_questions: [],
      extracted: {
        proposed_date: null,
        referral_name: null,
        referral_email: null,
        return_date: null,
      },
    };
  }
}
