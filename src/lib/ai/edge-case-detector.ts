/**
 * Stage 3: AI Edge Case Detector (DeepSeek)
 *
 * Paranoid safety check - finds ANY reason not to auto-reply.
 * Uses scoring rubric with 7.0/10 threshold.
 */

import { callAI } from './openrouter';
import { DECIDER_MODEL } from '@/lib/constants';
import type { ClassifierResult } from './reply-classifier';

export interface EdgeDetectorInput {
  contactName: string;
  companyName: string;
  latestInboundSubject: string;
  latestInboundBody: string;
  classifierResult: ClassifierResult;
}

export interface EdgeDetectorResult {
  safe_to_auto_reply: boolean;
  concerns: string[];
  recommendation: 'send' | 'founder' | 'skip';
  reasoning: string;
  scores: {
    intent_clarity: number;
    tone_safety: number;
    request_type: number;
    context_fit: number;
    weighted_total: number;
  };
}

const EDGE_DETECTOR_PROMPT = `You are a paranoid safety checker for auto-replies to cold outreach.

Your job: Find ANY reason why we should NOT auto-reply to this email.

Think about:
1. Could our auto-reply embarrass us?
2. Is this person asking for something we can't auto-provide?
3. Is there subtext we might miss?
4. Could this be a trap, test, or unusual situation?
5. Is the tone weird in any way?
6. Are they asking personal questions?
7. Is this actually spam or a sales pitch TO us?
8. Could a human reading this think "wait, what?"

## SCORING RUBRIC

Score each dimension 0-10:

| Dimension | Weight | 0 (Bad) | 5 (Neutral) | 10 (Good) |
|-----------|--------|---------|-------------|-----------|
| intent_clarity | 30% | Ambiguous, unclear | Somewhat clear | Crystal clear |
| tone_safety | 25% | Hostile, sarcastic, weird | Neutral/formal | Warm, professional |
| request_type | 25% | Asking for something we can't provide | Info question | Scheduling/positive |
| context_fit | 20% | Off-topic, random | Tangentially related | Direct response to outreach |

THRESHOLD: weighted_total must be >= 6.2 to be SAFE.

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

## KEY PRINCIPLE: POSITIVE + COMMON QUESTION = SAFE

If someone says YES and also asks a common question we have a standard answer for, that's SAFE.
Common questions with standard answers:
- "How did you find me?" → We researched high-growth companies
- "What are you building?" → PM tools for product prioritization
- "Who are you?" → Berkeley student founders
- "Are you funded?" → Self-funded, doing customer discovery

These are NOT dangerous because we have genuine, non-embarrassing answers.

## UNSAFE: Vague or open-ended requests without clear positive signal
- "Can you explain more?" → UNSAFE (vague, no positive signal)
- "Tell me more about this" → UNSAFE (too open-ended)
- "What exactly do you want?" → UNSAFE (skeptical, no positive)

## EXAMPLES

SAFE (positive + common question):
"Sure, happy to chat! How did you find me?" → 8.5 ✓ SAFE (positive + common question)
"Yeah I could do a quick call. What are you guys building?" → 8.0 ✓ SAFE (positive + standard answer)
"Go Bears! Happy to help. What are you working on?" → 9.0 ✓ SAFE (enthusiastic + common question)
"lol sure why not" → 7.5 ✓ SAFE (casual positive, they ARE agreeing)
"Yeah for sure! Always happy to chat with students." → 9.0 ✓ SAFE (enthusiastic positive)
"Sure, how did you find us though?" → 8.5 ✓ SAFE (common question, we can answer)
"I'd prefer email - can you send some questions?" → 8.0 ✓ SAFE (async preference, answerable)

UNSAFE (truly problematic):
"Sure, can you also send your resume?" → 4.6 ✗ UNSAFE (asking for OUR resume)
"Ok I guess" → 5.0 ✗ UNSAFE (reluctant/ambiguous, no clear positive)
"Yes, but first tell me about your salary expectations" → UNSAFE (job-related)
"Sounds good, I'll have my lawyer review" → UNSAFE (legal mention)
"Yes!! And we should totally partner!!" → UNSAFE (partnership ask)
"Sure, what's your personal cell?" → UNSAFE (personal info request)
"Can you explain more?" → UNSAFE (vague, no positive signal)
"Tell me more" → UNSAFE (too open-ended, no commitment)
"What do you want exactly?" → UNSAFE (skeptical tone, no positive)

The key difference: a positive signal ("sure", "yes", "happy to chat") + common question = SAFE.
No positive signal + vague request = UNSAFE.
`;

function buildUserMessage(opts: EdgeDetectorInput): string {
  const { classifierResult } = opts;
  return `Prospect: ${opts.contactName} at ${opts.companyName}

Their reply:
Subject: ${opts.latestInboundSubject}
Body: "${opts.latestInboundBody}"

Classifier says:
- Primary: ${classifierResult.primary_category}
- Secondary: ${classifierResult.secondary_categories.join(', ') || 'none'}
- Confidence: ${classifierResult.confidence}
- Flags: ${classifierResult.flags.join(', ') || 'none'}
- Embedded questions: ${classifierResult.embedded_questions.join(', ') || 'none'}

Is it safe to auto-reply? Score it.`;
}

export async function detectEdgeCases(opts: EdgeDetectorInput): Promise<EdgeDetectorResult> {
  const response = await callAI({
    model: DECIDER_MODEL,
    systemPrompt: EDGE_DETECTOR_PROMPT,
    userMessage: buildUserMessage(opts),
    jsonMode: true,
    maxTokens: 400,
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

    // Calculate weighted total if not provided
    const scores = parsed.scores || {};
    const intentClarity = typeof scores.intent_clarity === 'number' ? scores.intent_clarity : 5;
    const toneSafety = typeof scores.tone_safety === 'number' ? scores.tone_safety : 5;
    const requestType = typeof scores.request_type === 'number' ? scores.request_type : 5;
    const contextFit = typeof scores.context_fit === 'number' ? scores.context_fit : 5;

    const weightedTotal =
      intentClarity * 0.3 + toneSafety * 0.25 + requestType * 0.25 + contextFit * 0.2;

    const isSafe = weightedTotal >= 6.2 && parsed.safe_to_auto_reply !== false;

    return {
      safe_to_auto_reply: isSafe,
      concerns: parsed.concerns || [],
      recommendation: isSafe ? 'send' : (parsed.recommendation || 'founder'),
      reasoning: parsed.reasoning || '',
      scores: {
        intent_clarity: intentClarity,
        tone_safety: toneSafety,
        request_type: requestType,
        context_fit: contextFit,
        weighted_total: Math.round(weightedTotal * 10) / 10,
      },
    };
  } catch {
    // Parse error - be safe, route to founder
    return {
      safe_to_auto_reply: false,
      concerns: ['parse_error'],
      recommendation: 'founder',
      reasoning: 'Failed to parse AI response',
      scores: {
        intent_clarity: 0,
        tone_safety: 0,
        request_type: 0,
        context_fit: 0,
        weighted_total: 0,
      },
    };
  }
}
