import type { AiKeyQuote, AiPainPoint, AiProductFeedback, AiFollowUpSuggestion } from '@/types';

// One row per completed transcript after join. The orchestrator passes
// these around; retriever/profile-card/lead-index are the consumers.
//
// Two sources of "who was on the call":
//   - lead_id present  → customer call. lead_* fields populated.
//   - lead_id null     → advisor / misc call. participant_* fields populated.
export interface TranscriptRow {
  id: string;
  lead_id: string | null;
  kind?: 'customer_call' | 'advisor_call' | 'misc' | null;
  participant_name?: string | null;
  participant_context?: string | null;
  created_at: string;
  raw_text?: string | null;
  ai_summary?: string | null;
  ai_sentiment?: string | null;
  ai_interest_level?: string | null;
  ai_next_steps?: string | null;
  ai_pain_points?: AiPainPoint[] | null;
  ai_product_feedback?: AiProductFeedback[] | null;
  ai_key_quotes?: AiKeyQuote[] | null;
  ai_follow_up_suggestions?: AiFollowUpSuggestion[] | null;
  // Flattened lead fields from the join (null for advisor calls).
  lead_contact_name?: string | null;
  lead_company_name?: string | null;
  lead_stage?: string | null;
}

export type QuestionKind = 'lookup' | 'filter' | 'scope' | 'clarify';

export interface FilterSpec {
  // null means "user did not specify N"; the executor defaults to 20.
  n: number | null;
  // v1 only supports recency-ordered selection. Schema kept open for
  // future ordering modes (e.g. 'all', 'this_week') without breaking changes.
  ordering: 'recent';
  // Natural-language criterion as the founder phrased it. The classifier
  // tests each transcript against this string verbatim.
  criterion: string;
  criterion_type: 'factual' | 'semantic';
}

export type RouterOutput =
  | { kind: 'lookup'; search_terms: string[] }
  | { kind: 'scope'; search_terms: string[] }
  | { kind: 'filter'; search_terms: string[]; filter: FilterSpec }
  | { kind: 'clarify'; clarify_question: string };

export interface AdvocateOutput {
  side: 'for' | 'against';
  argument: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}
