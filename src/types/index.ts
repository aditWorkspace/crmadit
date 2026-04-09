export type LeadStage =
  | 'replied'
  | 'scheduling'
  | 'scheduled'
  | 'call_completed'
  | 'post_call'      // legacy — kept for DB compat, not shown in active flow
  | 'demo_sent'
  | 'feedback_call'
  | 'active_user'
  | 'paused'
  | 'dead';

export type InteractionType =
  | 'email_inbound'
  | 'email_outbound'
  | 'call'
  | 'note'
  | 'demo_sent'
  | 'follow_up_auto'
  | 'stage_change'
  | 'other';

export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type PocStatus = 'not_started' | 'preparing' | 'sent' | 'in_review' | 'completed' | 'failed';
export type FollowUpStatus = 'pending' | 'sent' | 'completed' | 'dismissed' | 'overdue' | 'failed';
export type TranscriptStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  major?: string;
  gmail_connected: boolean;
  gmail_token_expires_at?: string;
  created_at: string;
}

export interface Lead {
  id: string;
  contact_name: string;
  contact_email: string;
  contact_role?: string;
  contact_linkedin?: string;
  company_name: string;
  company_url?: string;
  company_stage?: string;
  company_size?: string;
  sourced_by: string;
  owned_by: string;
  call_participants: string[];
  stage: LeadStage;
  priority: Priority;
  first_reply_at?: string;
  our_first_response_at?: string;
  call_scheduled_for?: string;
  call_completed_at?: string;
  demo_sent_at?: string;
  product_access_granted_at?: string;
  last_contact_at?: string;
  next_followup_at?: string;
  time_to_our_response_hrs?: number;
  time_to_schedule_hrs?: number;
  time_to_call_hrs?: number;
  time_to_send_demo_hrs?: number;
  our_avg_reply_speed_hrs?: number;
  call_summary?: string;
  call_notes?: string;
  next_steps?: string;
  tags: string[];
  poc_status: PocStatus;
  poc_notes?: string;
  heat_score: number;
  ai_heat_reason?: string;
  ai_next_action?: string;
  ai_next_action_at?: string;
  paused_until?: string;
  paused_previous_stage?: LeadStage;
  pinned_note?: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  // Joined
  sourced_by_member?: TeamMember;
  owned_by_member?: TeamMember;
}

export interface ActionItem {
  id: string;
  lead_id: string;
  text: string;
  assigned_to?: string;
  due_date?: string;
  completed: boolean;
  completed_at?: string;
  source: 'manual' | 'ai_extracted' | 'auto_generated';
  sort_order: number;
  created_at: string;
  assigned_member?: TeamMember;
  lead?: Pick<Lead, 'id' | 'contact_name' | 'company_name'>;
}

export interface Interaction {
  id: string;
  lead_id: string;
  team_member_id?: string;
  type: InteractionType;
  subject?: string;
  body?: string;
  summary?: string;
  gmail_message_id?: string;
  gmail_thread_id?: string;
  occurred_at: string;
  response_time_hrs?: number;
  metadata: Record<string, unknown>;
  created_at: string;
  team_member?: TeamMember;
}

export interface Transcript {
  id: string;
  lead_id: string;
  source_type: 'txt_upload' | 'granola_link' | 'paste';
  granola_url?: string;
  file_path?: string;
  raw_text?: string;
  ai_summary?: string;
  ai_next_steps?: string;
  ai_action_items?: AiActionItem[];
  ai_sentiment?: string;
  ai_interest_level?: string;
  ai_key_quotes?: AiKeyQuote[];
  ai_pain_points?: AiPainPoint[];
  ai_product_feedback?: AiProductFeedback[];
  ai_follow_up_suggestions?: AiFollowUpSuggestion[];
  ai_contact_info_extracted?: {
    name: string | null;
    role: string | null;
    company: string | null;
    team_size: string | null;
    product_category: string | null;
  };
  processing_status: TranscriptStatus;
  processed_at?: string;
  created_at: string;
}

export interface AiActionItem {
  text: string;
  suggested_assignee?: string;
  suggested_due_date?: string;
  urgency: 'high' | 'medium' | 'low';
}

export interface AiKeyQuote {
  quote: string;
  context: string;
  speaker: string;
}

export interface AiPainPoint {
  pain_point: string;
  severity: 'high' | 'medium' | 'low';
}

export interface AiProductFeedback {
  feedback: string;
  category: 'positive' | 'concern' | 'suggestion' | 'question';
}

export interface AiFollowUpSuggestion {
  action: string;
  timing: string;
  reason: string;
}

export interface FollowUp {
  id: string;
  lead_id: string;
  assigned_to?: string;
  type: string;
  reason?: string;
  suggested_message?: string;
  due_at: string;
  auto_send: boolean;
  sent_at?: string;
  completed_at?: string;
  dismissed_at?: string;
  status: FollowUpStatus;
  created_at: string;
  lead?: Pick<Lead, 'id' | 'contact_name' | 'company_name' | 'stage'>;
  assigned_member?: TeamMember;
}

export interface ActivityLog {
  id: string;
  lead_id?: string;
  team_member_id?: string;
  action: string;
  details?: Record<string, unknown>;
  created_at: string;
  team_member?: TeamMember;
  lead?: Pick<Lead, 'id' | 'contact_name' | 'company_name'>;
}

export interface SessionUser {
  team_member_id: string;
  name: string;
}

export type KnowledgeDocType = 'problems' | 'product_feedback' | 'solutions' | 'problem_themes';

export interface KnowledgeDoc {
  id: string;
  doc_type: KnowledgeDocType;
  content: string;
  updated_at: string;
  created_at: string;
}

export interface ProblemThemeLead {
  name: string;
  company: string;
  pain_point: string;
}

export interface ProblemTheme {
  theme: string;
  severity: 'high' | 'medium' | 'low';
  frequency: number;
  leads: ProblemThemeLead[];
}

export interface ProblemThemesData {
  themes: ProblemTheme[];
  generated_at: string | null;
}

// Chat history
export interface ChatSession {
  id: string;
  title: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}
