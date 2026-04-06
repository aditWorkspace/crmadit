import { callAI } from './openrouter';
import { format } from 'date-fns';

export interface TranscriptAnalysis {
  summary: string;
  sentiment: string;
  interest_level: string;
  next_steps: string;
  action_items: Array<{
    text: string;
    suggested_assignee: string | null;
    suggested_due_date: string;
    urgency: 'high' | 'medium' | 'low';
  }>;
  key_quotes: Array<{
    quote: string;
    context: string;
    speaker: string;
  }>;
  pain_points: Array<{
    pain_point: string;
    severity: 'high' | 'medium' | 'low';
  }>;
  product_feedback: Array<{
    feedback: string;
    category: 'positive' | 'concern' | 'suggestion' | 'question';
  }>;
  follow_up_suggestions: Array<{
    action: string;
    timing: string;
    reason: string;
  }>;
  contact_info_extracted: {
    name: string | null;
    role: string | null;
    company: string | null;
    team_size: string | null;
    product_category: string | null;
  };
}

const SYSTEM_PROMPT = `You are an AI assistant analyzing a product discovery call transcript for Proxi AI, a startup building a PM command center. The call was between a Proxi AI founder and a potential customer (a PM or CEO at a B2C SaaS company).

Analyze the transcript and return a JSON object with these fields:

{
  "summary": "2-3 sentence summary of what was discussed and the outcome",
  "sentiment": "very_positive | positive | neutral | negative",
  "interest_level": "high | medium | low",
  "next_steps": "Clear paragraph of what should happen next. Be specific and actionable.",
  "action_items": [
    {
      "text": "specific action to take",
      "suggested_assignee": "name if mentioned or inferable, else null",
      "suggested_due_date": "ISO date string YYYY-MM-DD",
      "urgency": "high | medium | low"
    }
  ],
  "key_quotes": [
    {
      "quote": "verbatim quote from the customer",
      "context": "why this matters",
      "speaker": "name"
    }
  ],
  "pain_points": [
    { "pain_point": "description", "severity": "high | medium | low" }
  ],
  "product_feedback": [
    { "feedback": "what they said", "category": "positive | concern | suggestion | question" }
  ],
  "follow_up_suggestions": [
    {
      "action": "what to do next",
      "timing": "specific timing e.g. 'within 24 hours', 'next Monday'",
      "reason": "why this matters"
    }
  ],
  "contact_info_extracted": {
    "name": "their name if mentioned",
    "role": "their role if mentioned",
    "company": "company name if mentioned",
    "team_size": "if mentioned",
    "product_category": "what their company does"
  }
}

Every action item must have a due date. Return ONLY valid JSON, no markdown fences.`;

export async function processTranscript(rawText: string): Promise<TranscriptAnalysis> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const userMessage = `Today's date: ${today}\n\nTranscript:\n\n${rawText}`;

  const raw = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    jsonMode: true,
  });

  return JSON.parse(raw) as TranscriptAnalysis;
}
