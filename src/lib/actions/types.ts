import type { LeadStage, Priority } from '@/types';

// Shared types used by the action chat tools, dispatcher, and orchestrator.

export type ToolKind = 'read' | 'mutation';

// Generic tool definition. Each tool registers a Zod schema for its args
// (validated server-side before execution) plus the JSON-schema shape the
// LLM sees in its tools[] payload.
export interface ToolDef<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  kind: ToolKind;
  jsonSchema: Record<string, unknown>;       // OpenAPI-style schema for the LLM
  parse: (raw: unknown) => TArgs;            // throws on invalid args
  // For mutations: build a preview of what would change. Does NOT mutate.
  preview?: (args: TArgs, ctx: ToolContext) => Promise<MutationPreview>;
  // For reads: execute and return data. For mutations: execute the action
  // (called only after user confirmation, with the args from the pending row).
  execute: (args: TArgs, ctx: ToolContext) => Promise<TResult>;
}

export interface ToolContext {
  teamMemberId: string;
  teamMemberName: string;
}

// A mutation preview: lead-by-lead diff plus a summary line. Rendered as
// a confirmation card in the UI.
export interface MutationPreview {
  summary: string;                            // e.g. "Move 12 leads → demo_sent"
  affected: PreviewRow[];
  warnings?: string[];                        // e.g. "3 leads are already in this stage; will be no-ops"
  side_effects?: string[];                    // e.g. "Each move triggers stage hooks"
}

export interface PreviewRow {
  lead_id: string;
  contact_name: string;
  company_name: string;
  before: string;                             // human-readable current value
  after: string;                              // human-readable target value
}

// What read tools can return — kept loose since result shape varies per tool
// (find_leads returns a list, count_leads returns a number, etc.).
export type ReadResult =
  | { kind: 'lead_list'; leads: LeadSummary[]; total: number }
  | { kind: 'lead_detail'; lead: LeadDetail }
  | { kind: 'count'; total: number; breakdown?: Record<string, number> }
  | { kind: 'activity'; entries: ActivityEntry[] }
  | { kind: 'csv'; url: string; filename: string; row_count: number }
  | { kind: 'message'; text: string };

export interface LeadSummary {
  id: string;
  contact_name: string;
  contact_email: string;
  company_name: string;
  stage: LeadStage;
  priority: Priority;
  owned_by_name?: string;
  last_contact_at?: string;
  call_scheduled_for?: string;
  tags?: string[];
  heat_score?: number;
}

export interface LeadDetail extends LeadSummary {
  contact_role?: string;
  company_url?: string;
  call_completed_at?: string;
  demo_sent_at?: string;
  pinned_note?: string;
  call_summary?: string;
  next_steps?: string;
  recent_interactions: Array<{
    type: string;
    summary?: string;
    subject?: string;
    created_at: string;
  }>;
  recent_action_items: Array<{ text: string; completed: boolean; due_date?: string }>;
}

export interface ActivityEntry {
  action: string;
  details?: Record<string, unknown>;
  actor?: string;
  lead?: { id: string; name: string; company: string };
  created_at: string;
}

// Filter shape used by find_leads / count_leads / export_csv. All optional;
// AND-combined.
export interface LeadFilter {
  stage?: LeadStage | LeadStage[];
  owner?: string;                              // team member name OR id
  priority?: Priority | Priority[];
  tag?: string;                                // single tag substring
  name_contains?: string;                      // contact_name or company_name
  email?: string;                              // exact email
  contacted_within_days?: number;              // last_contact_at >= now - N days
  stale_for_days?: number;                     // last_contact_at <= now - N days
  call_in_last_days?: number;                  // call_scheduled_for or call_completed_at within N days
  call_completed_within_days?: number;
  is_archived?: boolean;
  limit?: number;                              // hard cap; defaults to 50, max 500
}
