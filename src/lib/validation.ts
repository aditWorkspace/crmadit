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
  confidence: z.number().min(0).max(1).default(0),
});

// 25 categories for first-reply classification
export const firstReplyCategorySchema = z.enum([
  // GROUP A: Positive (auto-reply with booking link)
  'positive_enthusiastic',
  'positive_casual',
  'positive_send_times',
  'positive_specific_day',
  // GROUP B: Async/email preference (auto-reply without call push)
  'async_prefer_email',
  'async_send_info',
  'async_busy',
  // GROUP C: Info request (auto-reply with Q&A answer)
  'info_what_is_it',
  'info_team',
  'info_funding',
  'info_general',
  // GROUP D: Delay (schedule follow-up, brief ack)
  'delay_specific_date',
  'delay_after_event',
  'delay_traveling',
  'delay_generic',
  'delay_ooo',
  // GROUP E: Referral (ask for contact info)
  'referral_named',
  'referral_unknown',
  // GROUP F: Decline (NO auto-reply)
  'decline_polite',
  'decline_firm',
  'decline_unsubscribe',
  // GROUP G: Manual review
  'calendly_sent',
  'question_compliance',
  'question_technical',
  'question_pricing',
  // Fallback
  'unclear',
  // Dedicated edge-case bucket: the ~1% of replies that don't cleanly fit any
  // other category (random asides, off-topic remarks, unusual tone, etc.).
  // Always routed to the founder for manual handling.
  'other',
]);

export const firstReplyDecisionSchema = z.object({
  category: firstReplyCategorySchema,
  reason: z.string(),
  // 0-1 confidence in the chosen category. Low values route to manual review
  // regardless of category so the founder handles anything ambiguous.
  confidence: z.number().min(0).max(1).default(0),
  // For delay_* categories: the target follow-up date
  follow_up_date: z.string().nullable().optional(),
  // For referral_named: the referred person's name
  referral_name: z.string().nullable().optional(),
  // For referral_named: the referred person's email if provided
  referral_email: z.string().nullable().optional(),
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
export type FirstReplyCategory = z.infer<typeof firstReplyCategorySchema>;
export type AiTranscriptAnalysis = z.infer<typeof aiTranscriptAnalysisSchema>;

// ── Cold-email personalization (research → evidence → write → claim-check) ──
// The extraction model emits structured evidence cards; it NEVER sets tier or
// score. URL validity is checked in code (verifyEvidence), so source_url is a
// permissive nullable string here — a malformed URL becomes a verification
// failure, not a parse failure that loses the whole research blob.

export const evidenceKindSchema = z.enum([
  'person_quote',           // tier 1 — direct quote/point about customers/feedback/roadmap
  'person_post',            // tier 1 — post/podcast/talk by the person on those themes
  'company_changelog',      // tier 2 — shipped feature / changelog / launch
  'company_customer_story', // tier 2 — published customer story / case study
  'company_hiring',         // tier 3 — hiring product/support/customer/ops/eng
  'tool_stack',             // tier 4 — their actual support/sales/eng tools
  'adjacent_tool',          // tier 5 — competing/adjacent tool or prioritization process
  'public_complaint',       // supporting only — never an opener
  'role_based',             // tier 6 — generic fallback
]);

export const evidenceSourceTypeSchema = z.enum(['firecrawl', 'sonar', 'derived']);

export const evidenceCardSchema = z.object({
  id: z.string().min(1),
  kind: evidenceKindSchema,
  statement: z.string().min(1),       // one-line factual claim, used by the writer
  evidence_quote: z.string().nullable().default(null), // verbatim snippet backing it
  source_url: z.string().nullable().default(null),
  source_type: evidenceSourceTypeSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  // Filled in by code (verifyEvidence), not trusted from the model.
  usable_in_email: z.boolean().default(false),
  supporting_only: z.boolean().default(false),
  reject_reason: z.string().nullable().default(null),
});

export const coldExtractionSchema = z.object({
  cards: z.array(evidenceCardSchema).default([]),
  linkedin_exists: z.boolean().default(false),
});

export const coldWriteSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const claimTypeSchema = z.enum([
  'proxi_claim',                  // a claim about Proxi / what we do
  'recipient_company_person_claim', // a claim about THEM — must map to a selected card
  'generic_role_pain',            // a generic pain anyone in their seat has
  'cta_opinion',                  // the ask / an opinion, not a factual claim
]);

export const claimCheckSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    type: claimTypeSchema,
    supported: z.boolean().default(false),
    evidence_id: z.string().nullable().default(null),
  })).default([]),
});

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;
export type EvidenceCard = z.infer<typeof evidenceCardSchema>;
export type ColdExtraction = z.infer<typeof coldExtractionSchema>;
export type ColdWrite = z.infer<typeof coldWriteSchema>;
export type ClaimType = z.infer<typeof claimTypeSchema>;
export type ClaimCheck = z.infer<typeof claimCheckSchema>;
