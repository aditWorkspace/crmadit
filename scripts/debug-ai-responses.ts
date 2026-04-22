import { config } from 'dotenv';
config({ path: '.env.local' });

import { callAI } from '../src/lib/ai/openrouter';
import { WRITER_MODEL, DECIDER_MODEL } from '../src/lib/constants';

const CLASSIFIER_PROMPT = `You are classifying a prospect's email reply to cold outreach about product prioritization.

OUTPUT JSON ONLY:
{
  "primary_category": "<main_category>",
  "secondary_categories": ["<category2>", "<category3>"],
  "sub_category": "<specific_type>",
  "confidence": 0.0-1.0,
  "flags": ["flag1", "flag2"],
  "embedded_questions": ["how did you find us", "what do you do"],
  "extracted": {
    "proposed_date": "YYYY-MM-DD" | null,
    "referral_name": "string" | null,
    "referral_email": "string" | null,
    "return_date": "YYYY-MM-DD" | null
  }
}

## MAIN CATEGORIES & SUB-CATEGORIES

### POSITIVE (wants to talk)
- positive_enthusiastic: "Yes! Would love to chat", "Absolutely, let's do it"
- positive_casual: "Sure", "Yeah I'm down", "Happy to chat"
- positive_send_times: "Send me some times", "What's your availability"

### INFO_REQUEST (asking about us)
- info_what_is_it: "What is Proxi", "What are you building"
- info_how_found: "How did you find me", "How did you come across us"
- info_team: "Who are you", "Tell me about your team"

### ASYNC (prefers email)
- async_prefer_email: "I'd rather do this over email"
- async_send_info: "Can you send more info first"

### DECLINE (not interested)
- decline_polite: "Not a fit right now", "I'll pass"
- decline_firm: "Not interested", "No"

Classify the reply below.`;

const EDGE_DETECTOR_PROMPT = `You are a paranoid safety checker for auto-replies to cold outreach.

Your job: Find ANY reason why we should NOT auto-reply to this email.

## SCORING RUBRIC

Score each dimension 0-10:

| Dimension | Weight | 0 (Bad) | 5 (Neutral) | 10 (Good) |
|-----------|--------|---------|-------------|-----------|
| intent_clarity | 30% | Ambiguous, unclear | Somewhat clear | Crystal clear |
| tone_safety | 25% | Hostile, sarcastic, weird | Neutral/formal | Warm, professional |
| request_type | 25% | Asking for something we can't provide | Info question | Scheduling/positive |
| context_fit | 20% | Off-topic, random | Tangentially related | Direct response to outreach |

THRESHOLD: weighted_total must be >= 7.0 to be SAFE.

OUTPUT JSON ONLY:
{
  "safe_to_auto_reply": true | false,
  "concerns": ["concern1", "concern2"],
  "recommendation": "send" | "founder" | "skip",
  "reasoning": "brief explanation",
  "scores": {
    "intent_clarity": 0-10,
    "tone_safety": 0-10,
    "request_type": 0-10,
    "context_fit": 0-10,
    "weighted_total": 0-10
  }
}

Score the email below.`;

async function testClassifier() {
  console.log('Testing classifier with Haiku...\n');
  console.log('Model:', WRITER_MODEL);

  const userMessage = `Prospect: Faisal Ahmed at Ramp

Latest inbound reply:
Subject: Re: product prioritization at Ramp
Body: "Yes we could jump on a call next week. Out of curiosity how did you come across our company?"

Classify this reply.`;

  console.log('\nUser message:', userMessage);
  console.log('\n---\n');

  try {
    const response = await callAI({
      model: WRITER_MODEL,
      systemPrompt: CLASSIFIER_PROMPT,
      userMessage,
      jsonMode: true,
      maxTokens: 500,
    });

    console.log('Raw classifier response:');
    console.log(response);
    console.log('\n---\n');

    const parsed = JSON.parse(response);
    console.log('Parsed:', JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error('Classifier error:', err);
  }
}

async function testEdgeDetector() {
  console.log('\n\nTesting edge detector with DeepSeek...\n');
  console.log('Model:', DECIDER_MODEL);

  const userMessage = `Prospect: Sarah Chen at Stripe

Their reply:
Subject: Re: product prioritization at Stripe
Body: "Yes! Would love to chat. This sounds really interesting."

Classifier says:
- Primary: positive_enthusiastic
- Secondary: none
- Confidence: 0.98
- Flags: enthusiastic_tone
- Embedded questions: none

Is it safe to auto-reply? Score it.`;

  console.log('\nUser message:', userMessage);
  console.log('\n---\n');

  try {
    const response = await callAI({
      model: DECIDER_MODEL,
      systemPrompt: EDGE_DETECTOR_PROMPT,
      userMessage,
      jsonMode: true,
      maxTokens: 400,
    });

    console.log('Raw edge detector response:');
    console.log(response);
    console.log('\n---\n');

    const parsed = JSON.parse(response);
    console.log('Parsed:', JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error('Edge detector error:', err);
  }
}

async function main() {
  await testClassifier();
  await testEdgeDetector();
}

main().catch(console.error);
