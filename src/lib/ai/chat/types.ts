import type { AiKeyQuote, AiPainPoint, AiProductFeedback, AiFollowUpSuggestion } from '@/types';

// One row per completed transcript after join. The orchestrator passes
// these around; retriever/profile-card/lead-index are the consumers.
export interface TranscriptRow {
  id: string;
  lead_id: string;
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
  // Flattened lead fields from the join.
  lead_contact_name?: string | null;
  lead_company_name?: string | null;
  lead_stage?: string | null;
}

export type QuestionKind = 'lookup' | 'scope';

export interface RouterOutput {
  kind: QuestionKind;
  search_terms: string[];
}

export interface AdvocateOutput {
  side: 'for' | 'against';
  argument: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}
