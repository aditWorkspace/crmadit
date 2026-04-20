import { z } from 'zod';

// ── Lead enums ──────────────────────────────────────────────────────────────

export const leadStageSchema = z.enum([
  'replied', 'scheduling', 'scheduled', 'call_completed',
  'post_call', 'demo_sent', 'feedback_call', 'active_user',
  'paused', 'dead',
]);

export const prioritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export const pocStatusSchema = z.enum([
  'not_started', 'preparing', 'sent', 'in_review', 'completed', 'failed',
]);

// ── Lead creation ───────────────────────────────────────────────────────────

export const createLeadSchema = z.object({
  contact_name: z.string().min(1, 'contact_name is required'),
  contact_email: z.string().email('Invalid contact email'),
  company_name: z.string().min(1, 'company_name is required'),
  contact_role: z.string().optional(),
  contact_linkedin: z.string().optional(),
  company_url: z.string().optional(),
  company_stage: z.string().optional(),
  company_size: z.string().optional(),
  owned_by: z.string().uuid().optional(),
  sourced_by: z.string().uuid().optional(),
  stage: leadStageSchema.optional(),
  priority: prioritySchema.optional(),
  poc_status: pocStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  call_scheduled_for: z.string().datetime().optional().nullable(),
  pinned_note: z.string().optional(),
});

// ── Lead update ─────────────────────────────────────────────────────────────

export const updateLeadSchema = z.object({
  contact_name: z.string().min(1).optional(),
  contact_email: z.string().email().optional(),
  contact_role: z.string().optional().nullable(),
  contact_linkedin: z.string().optional().nullable(),
  company_name: z.string().min(1).optional(),
  company_url: z.string().optional().nullable(),
  company_stage: z.string().optional().nullable(),
  company_size: z.string().optional().nullable(),
  owned_by: z.string().uuid().optional(),
  sourced_by: z.string().uuid().optional(),
  stage: leadStageSchema.optional(),
  priority: prioritySchema.optional(),
  poc_status: pocStatusSchema.optional(),
  heat_score: z.number().min(0).max(100).optional(),
  tags: z.array(z.string()).optional(),
  call_scheduled_for: z.string().datetime().optional().nullable(),
  call_completed_at: z.string().datetime().optional().nullable(),
  demo_sent_at: z.string().datetime().optional().nullable(),
  call_summary: z.string().optional().nullable(),
  call_notes: z.string().optional().nullable(),
  next_steps: z.string().optional().nullable(),
  pinned_note: z.string().optional().nullable(),
  paused_until: z.string().datetime().optional().nullable(),
  paused_previous_stage: leadStageSchema.optional().nullable(),
  call_participants: z.array(z.string().uuid()).optional(),
  handoff_note: z.string().optional(),
}).strict().refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update',
});

// ── AI response schemas ─────────────────────────────────────────────────────

export const aiFollowupDecisionSchema = z.object({
  should_send: z.boolean(),
  reason: z.string(),
  message: z.string().nullable(),
});

export const firstReplyDecisionSchema = z.object({
  classification: z.enum([
    'positive_book',
    'async_request',
    'info_request',
    'calendly_sent',
    'question_only',
    'decline',
    'ooo',
    'unclear',
  ]),
  reason: z.string(),
  // Classifier no longer writes prose. Non-null only on legacy runs where the
  // classifier and writer still share a model.
  message: z.string().nullable(),
  // One-sentence plan for the writer module. Always populated for auto-send
  // classifications (positive_book / async_request / info_request); null
  // otherwise.
  content_plan: z.string().nullable().optional(),
});

export const aiTranscriptAnalysisSchema = z.object({
  summary: z.string().default(''),
  sentiment: z.string().default('neutral'),
  interest_level: z.string().default('medium'),
  next_steps: z.string().default(''),
  action_items: z.array(z.object({
    text: z.string(),
    suggested_assignee: z.string().nullable().default(null),
    suggested_due_date: z.string(),
    urgency: z.enum(['high', 'medium', 'low']).default('medium'),
  })).default([]),
  key_quotes: z.array(z.object({
    quote: z.string(),
    context: z.string(),
    speaker: z.string(),
  })).default([]),
  pain_points: z.array(z.object({
    pain_point: z.string(),
    severity: z.enum(['high', 'medium', 'low']).default('medium'),
  })).default([]),
  product_feedback: z.array(z.object({
    feedback: z.string(),
    category: z.enum(['positive', 'concern', 'suggestion', 'question']).default('suggestion'),
  })).default([]),
  follow_up_suggestions: z.array(z.object({
    action: z.string(),
    timing: z.string(),
    reason: z.string(),
  })).default([]),
  contact_info_extracted: z.object({
    name: z.string().nullable().default(null),
    role: z.string().nullable().default(null),
    company: z.string().nullable().default(null),
    team_size: z.string().nullable().default(null),
    product_category: z.string().nullable().default(null),
  }).default({ name: null, role: null, company: null, team_size: null, product_category: null }),
});

export type AiFollowupDecision = z.infer<typeof aiFollowupDecisionSchema>;
export type FirstReplyDecision = z.infer<typeof firstReplyDecisionSchema>;
export type AiTranscriptAnalysis = z.infer<typeof aiTranscriptAnalysisSchema>;
