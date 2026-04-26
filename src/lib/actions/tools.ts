import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { changeStage } from '@/lib/automation/stage-logic';
import { STAGE_ORDER } from '@/lib/constants';
import type { LeadStage, Priority } from '@/types';
import type { ToolDef, MutationPreview, PreviewRow, LeadSummary, LeadDetail, ActivityEntry, LeadFilter, ReadResult } from './types';
import {
  resolveLeadIdentifiers,
  resolveTeamMember,
  applyLeadFilter,
  teamMemberMap,
  teamMemberNames,
  toLeadSummary,
} from './resolvers';
import { leadsToCsv, uploadCsv, DEFAULT_LEAD_CSV_COLUMNS } from './csv';

// ════════════════════════════════════════════════════════════════════
// Filter schema (shared by find_leads / count_leads / export_csv)
// ════════════════════════════════════════════════════════════════════

const stageEnum = z.enum([
  'replied', 'scheduling', 'scheduled', 'call_completed', 'post_call',
  'demo_sent', 'feedback_call', 'active_user', 'paused', 'dead',
]);
const priorityEnum = z.enum(['critical', 'high', 'medium', 'low']);

const leadFilterSchema = z.object({
  stage: z.union([stageEnum, z.array(stageEnum)]).optional(),
  owner: z.string().optional(),
  priority: z.union([priorityEnum, z.array(priorityEnum)]).optional(),
  tag: z.string().optional(),
  name_contains: z.string().optional(),
  email: z.string().optional(),
  contacted_within_days: z.number().int().positive().optional(),
  stale_for_days: z.number().int().positive().optional(),
  call_in_last_days: z.number().int().positive().optional(),
  call_completed_within_days: z.number().int().positive().optional(),
  is_archived: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const filterJsonSchema = {
  type: 'object',
  properties: {
    stage: { description: 'Single stage or array of stages', oneOf: [{ type: 'string', enum: stageEnum.options }, { type: 'array', items: { type: 'string', enum: stageEnum.options } }] },
    owner: { type: 'string', description: 'Team member name or "me"' },
    priority: { description: 'Single priority or array', oneOf: [{ type: 'string', enum: priorityEnum.options }, { type: 'array', items: { type: 'string', enum: priorityEnum.options } }] },
    tag: { type: 'string' },
    name_contains: { type: 'string', description: 'Substring match on contact_name OR company_name' },
    email: { type: 'string', description: 'Exact email match' },
    contacted_within_days: { type: 'integer', description: 'last_contact_at within last N days' },
    stale_for_days: { type: 'integer', description: 'last_contact_at older than N days' },
    call_in_last_days: { type: 'integer', description: 'call_scheduled_for OR call_completed_at within last N days' },
    call_completed_within_days: { type: 'integer', description: 'call_completed_at within last N days' },
    is_archived: { type: 'boolean', description: 'Default false (only active leads)' },
    limit: { type: 'integer', description: 'Max rows; default 50, max 500' },
  },
};

// ════════════════════════════════════════════════════════════════════
// Helper: resolve a list of identifier strings + a filter into a final
// set of lead IDs. Used by every mutation tool.
// ════════════════════════════════════════════════════════════════════

interface IdentifyArgs {
  lead_ids?: string[];
  emails?: string[];
  filter?: LeadFilter;
}

async function identifyLeads(args: IdentifyArgs): Promise<{ ids: string[]; resolved_inputs: Array<{ input: string; id: string }>; errors: string[] }> {
  const supabase = createAdminClient();
  const ids = new Set<string>();
  const resolved_inputs: Array<{ input: string; id: string }> = [];
  const errors: string[] = [];

  // Direct identifiers (uuid + email).
  const inputs: string[] = [...(args.lead_ids ?? []), ...(args.emails ?? [])];
  if (inputs.length) {
    const r = await resolveLeadIdentifiers(inputs);
    for (const rl of r.resolved) {
      ids.add(rl.id);
      resolved_inputs.push({ input: rl.input, id: rl.id });
    }
    for (const u of r.unresolved) {
      const detail = u.reason === 'ambiguous'
        ? `ambiguous: ${u.candidates?.map(c => `${c.contact_name} @ ${c.company_name}`).join(', ')}`
        : 'no match';
      errors.push(`"${u.input}" — ${detail}`);
    }
  }

  // Filter expansion.
  if (args.filter) {
    const tmap = await teamMemberMap();
    let q = supabase.from('leads').select('id, contact_name, company_name');
    q = applyLeadFilter(q, args.filter, { teamMemberByName: tmap });
    if (args.filter.limit) q = q.limit(args.filter.limit);
    else q = q.limit(500);
    const { data, error } = await q;
    if (error) errors.push(`filter query: ${error.message}`);
    for (const row of (data || []) as Array<{ id: string }>) ids.add(row.id);
  }

  return { ids: [...ids], resolved_inputs, errors };
}

// ════════════════════════════════════════════════════════════════════
// Read tools
// ════════════════════════════════════════════════════════════════════

const findLeadsTool: ToolDef<{ filter: LeadFilter; limit?: number }, ReadResult> = {
  name: 'find_leads',
  description: 'Find leads matching a filter. Read-only. Returns up to N leads with summary fields. Use for "show me…", "list…", "find anyone who…" style questions.',
  kind: 'read',
  jsonSchema: {
    type: 'object',
    properties: {
      filter: filterJsonSchema,
      limit: { type: 'integer', description: 'Max rows; default 50, max 500' },
    },
    required: ['filter'],
  },
  parse: raw => z.object({ filter: leadFilterSchema, limit: z.number().int().positive().max(500).optional() }).parse(raw),
  execute: async ({ filter, limit }): Promise<ReadResult> => {
    const supabase = createAdminClient();
    const tmap = await teamMemberMap();
    const names = await teamMemberNames();
    const cap = limit ?? filter.limit ?? 50;
    let q = supabase
      .from('leads')
      .select('id, contact_name, contact_email, company_name, stage, priority, owned_by, last_contact_at, call_scheduled_for, tags, heat_score', { count: 'exact' });
    q = applyLeadFilter(q, filter, { teamMemberByName: tmap });
    q = q.order('last_contact_at', { ascending: false, nullsFirst: false }).limit(cap);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const leads = (data || []).map(row => toLeadSummary(row as unknown as Record<string, unknown>, names));
    return { kind: 'lead_list', leads, total: count ?? leads.length };
  },
};

const getLeadTool: ToolDef<{ identifier: string }, ReadResult> = {
  name: 'get_lead',
  description: 'Get full detail for ONE lead by name, email, "Name @ Company", or UUID. Includes recent interactions and action items. Use for "what is the status of X?".',
  kind: 'read',
  jsonSchema: {
    type: 'object',
    properties: { identifier: { type: 'string', description: 'Name, email, "Name @ Company", or UUID' } },
    required: ['identifier'],
  },
  parse: raw => z.object({ identifier: z.string().min(1) }).parse(raw),
  execute: async ({ identifier }): Promise<ReadResult> => {
    const r = await resolveLeadIdentifiers([identifier]);
    if (r.unresolved.length) {
      const u = r.unresolved[0];
      const cand = u.candidates?.map(c => `${c.contact_name} @ ${c.company_name}`).join(', ');
      return { kind: 'message', text: u.reason === 'ambiguous' ? `Ambiguous: ${identifier} matches ${cand}` : `No lead found for "${identifier}"` };
    }
    const id = r.resolved[0].id;
    const supabase = createAdminClient();
    const names = await teamMemberNames();
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).single();
    if (error || !lead) return { kind: 'message', text: 'Lead row not found' };
    const { data: interactions } = await supabase
      .from('interactions')
      .select('type, summary, subject, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    const { data: actionItems } = await supabase
      .from('action_items')
      .select('text, completed, due_date')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    const detail: LeadDetail = {
      ...toLeadSummary(lead as unknown as Record<string, unknown>, names),
      contact_role: lead.contact_role,
      company_url: lead.company_url,
      call_completed_at: lead.call_completed_at,
      demo_sent_at: lead.demo_sent_at,
      pinned_note: lead.pinned_note,
      call_summary: lead.call_summary,
      next_steps: lead.next_steps,
      recent_interactions: (interactions || []).map(i => ({ type: i.type, summary: i.summary, subject: i.subject, created_at: i.created_at })),
      recent_action_items: (actionItems || []).map(a => ({ text: a.text, completed: a.completed, due_date: a.due_date })),
    };
    return { kind: 'lead_detail', lead: detail };
  },
};

const countLeadsTool: ToolDef<{ filter: LeadFilter; group_by?: 'stage' | 'priority' | 'owner' }, ReadResult> = {
  name: 'count_leads',
  description: 'Count leads matching a filter. Optionally group by stage/priority/owner. Use for "how many…?".',
  kind: 'read',
  jsonSchema: {
    type: 'object',
    properties: {
      filter: filterJsonSchema,
      group_by: { type: 'string', enum: ['stage', 'priority', 'owner'] },
    },
    required: ['filter'],
  },
  parse: raw => z.object({ filter: leadFilterSchema, group_by: z.enum(['stage', 'priority', 'owner']).optional() }).parse(raw),
  execute: async ({ filter, group_by }): Promise<ReadResult> => {
    const supabase = createAdminClient();
    const tmap = await teamMemberMap();
    const names = await teamMemberNames();
    let q = supabase.from('leads').select('stage, priority, owned_by', { count: 'exact' });
    q = applyLeadFilter(q, filter, { teamMemberByName: tmap });
    q = q.limit(10_000);
    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    let breakdown: Record<string, number> | undefined;
    if (group_by) {
      breakdown = {};
      for (const row of (data || []) as Array<{ stage: string; priority: string; owned_by: string | null }>) {
        const key = group_by === 'owner'
          ? (row.owned_by ? names[row.owned_by] || row.owned_by : 'unassigned')
          : (row[group_by] as string);
        breakdown[key] = (breakdown[key] || 0) + 1;
      }
    }
    return { kind: 'count', total: count ?? 0, breakdown };
  },
};

const recentActivityTool: ToolDef<{ days?: number; lead?: string; actor?: string }, ReadResult> = {
  name: 'recent_activity',
  description: 'Get the activity log for the last N days, optionally scoped to a specific lead or team member. Default 7 days.',
  kind: 'read',
  jsonSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'How many days back; default 7, max 90' },
      lead: { type: 'string', description: 'Lead identifier (name/email/uuid) to scope to' },
      actor: { type: 'string', description: 'Team member name to scope to' },
    },
  },
  parse: raw => z.object({
    days: z.number().int().positive().max(90).optional(),
    lead: z.string().optional(),
    actor: z.string().optional(),
  }).parse(raw),
  execute: async ({ days = 7, lead, actor }, ctx): Promise<ReadResult> => {
    const supabase = createAdminClient();
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    let q = supabase
      .from('activity_log')
      .select('action, details, lead_id, team_member_id, created_at')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(50);
    if (lead) {
      const r = await resolveLeadIdentifiers([lead]);
      if (!r.resolved.length) return { kind: 'message', text: `No lead matched "${lead}"` };
      q = q.eq('lead_id', r.resolved[0].id);
    }
    if (actor) {
      const a = await resolveTeamMember(actor, ctx.teamMemberId);
      if (a) q = q.eq('team_member_id', a.id);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const names = await teamMemberNames();
    // Hydrate lead names for context.
    const leadIds = [...new Set((data || []).map(r => r.lead_id).filter(Boolean))] as string[];
    const leadInfo: Record<string, { name: string; company: string }> = {};
    if (leadIds.length) {
      const { data: leads } = await supabase.from('leads').select('id, contact_name, company_name').in('id', leadIds);
      for (const l of leads || []) leadInfo[l.id] = { name: l.contact_name, company: l.company_name };
    }
    const entries: ActivityEntry[] = (data || []).map(r => ({
      action: r.action,
      details: r.details as Record<string, unknown> | undefined,
      actor: r.team_member_id ? names[r.team_member_id] : undefined,
      lead: r.lead_id && leadInfo[r.lead_id] ? { id: r.lead_id, name: leadInfo[r.lead_id].name, company: leadInfo[r.lead_id].company } : undefined,
      created_at: r.created_at,
    }));
    return { kind: 'activity', entries };
  },
};

const exportCsvTool: ToolDef<{ filter: LeadFilter; columns?: string[] }, ReadResult> = {
  name: 'export_csv',
  description: 'Export leads matching a filter to a downloadable CSV. Returns a signed URL valid for 1 hour. Use for "give me a CSV…", "export…".',
  kind: 'read',
  jsonSchema: {
    type: 'object',
    properties: {
      filter: filterJsonSchema,
      columns: { type: 'array', items: { type: 'string' }, description: `Columns to include. Default: ${DEFAULT_LEAD_CSV_COLUMNS.join(', ')}` },
    },
    required: ['filter'],
  },
  parse: raw => z.object({ filter: leadFilterSchema, columns: z.array(z.string()).optional() }).parse(raw),
  execute: async ({ filter, columns }): Promise<ReadResult> => {
    const supabase = createAdminClient();
    const tmap = await teamMemberMap();
    const names = await teamMemberNames();
    let q = supabase
      .from('leads')
      .select('id, contact_name, contact_email, company_name, stage, priority, owned_by, last_contact_at, call_scheduled_for, tags, heat_score, contact_role, company_url, call_completed_at, demo_sent_at');
    q = applyLeadFilter(q, filter, { teamMemberByName: tmap });
    q = q.limit(filter.limit ?? 5000);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data || []).map(row => {
      const summary = toLeadSummary(row as unknown as Record<string, unknown>, names);
      return {
        ...summary,
        contact_role: (row as unknown as Record<string, unknown>).contact_role,
        company_url: (row as unknown as Record<string, unknown>).company_url,
        call_completed_at: (row as unknown as Record<string, unknown>).call_completed_at,
        demo_sent_at: (row as unknown as Record<string, unknown>).demo_sent_at,
      };
    });
    const csv = leadsToCsv(rows as unknown as LeadSummary[], columns);
    const today = new Date().toISOString().slice(0, 10);
    const filename = `proxi-leads-${today}.csv`;
    const { url } = await uploadCsv(csv, filename);
    return { kind: 'csv', url, filename, row_count: rows.length };
  },
};

// ════════════════════════════════════════════════════════════════════
// Mutation tools
// All share an identify shape: { lead_ids?, emails?, filter? }, and any
// op-specific field. Preview returns lead-by-lead diffs. Execute uses the
// captured args from the pending row.
// ════════════════════════════════════════════════════════════════════

async function fetchLeadsByIds(ids: string[]) {
  if (!ids.length) return [];
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, priority, owned_by, tags')
    .in('id', ids);
  return data || [];
}

const moveLeadsToStageTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; to_stage?: LeadStage; bump?: number }, MutationPreview | { ok: true; moved: number; errors: string[] }> = {
  name: 'move_leads_to_stage',
  description: 'Bulk move leads to a target stage. Identify leads via lead_ids OR emails OR filter. Optional `bump` (positive integer) advances each lead that many stages forward in the canonical pipeline order instead of using to_stage.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      to_stage: { type: 'string', enum: stageEnum.options },
      bump: { type: 'integer', description: 'Move each lead this many stages forward (mutually exclusive with to_stage)' },
    },
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    to_stage: stageEnum.optional(),
    bump: z.number().int().positive().max(5).optional(),
  }).refine(d => d.to_stage || d.bump, { message: 'either to_stage or bump required' })
    .refine(d => d.lead_ids?.length || d.emails?.length || d.filter, { message: 'must provide lead_ids, emails, or filter' })
    .parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const affected: PreviewRow[] = [];
    const warnings: string[] = [...ident.errors];
    for (const lead of leads) {
      const target = args.to_stage ?? bumpedStage(lead.stage as LeadStage, args.bump ?? 1);
      if (lead.stage === target) {
        warnings.push(`${lead.contact_name} @ ${lead.company_name} is already in ${target} (will be skipped)`);
        continue;
      }
      affected.push({
        lead_id: lead.id,
        contact_name: lead.contact_name,
        company_name: lead.company_name,
        before: lead.stage,
        after: target,
      });
    }
    return {
      summary: `Move ${affected.length} lead${affected.length === 1 ? '' : 's'} → ${args.to_stage ?? `+${args.bump ?? 1} stage(s)`}`,
      affected,
      warnings: warnings.length ? warnings : undefined,
      side_effects: ['Each move runs the stage hook (auto action items, follow-ups, post-call timer, etc.)'],
    };
  },
  execute: async (args, ctx) => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const errors: string[] = [];
    let moved = 0;
    for (const lead of leads) {
      const target = args.to_stage ?? bumpedStage(lead.stage as LeadStage, args.bump ?? 1);
      if (lead.stage === target) continue;
      const r = await changeStage(lead.id, target, ctx.teamMemberId);
      if (!r.success) errors.push(`${lead.contact_name}: ${r.error}`);
      else moved++;
    }
    return { ok: true, moved, errors };
  },
};

function bumpedStage(current: LeadStage, by: number): LeadStage {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx < 0) return current;
  const next = Math.min(idx + by, STAGE_ORDER.length - 1);
  return STAGE_ORDER[next];
}

const updateLeadPriorityTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; to_priority: Priority }, MutationPreview | { ok: true; updated: number; errors: string[] }> = {
  name: 'update_lead_priority',
  description: 'Bulk update priority on identified leads.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      to_priority: { type: 'string', enum: priorityEnum.options },
    },
    required: ['to_priority'],
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    to_priority: priorityEnum,
  }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const affected: PreviewRow[] = leads
      .filter(l => l.priority !== args.to_priority)
      .map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: l.priority, after: args.to_priority }));
    return {
      summary: `Set priority=${args.to_priority} on ${affected.length} lead${affected.length === 1 ? '' : 's'}`,
      affected,
      warnings: ident.errors.length ? ident.errors : undefined,
    };
  },
  execute: async (args) => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    if (!ident.ids.length) return { ok: true, updated: 0, errors: ident.errors };
    const supabase = createAdminClient();
    const { error } = await supabase.from('leads').update({ priority: args.to_priority }).in('id', ident.ids);
    if (error) throw new Error(error.message);
    return { ok: true, updated: ident.ids.length, errors: ident.errors };
  },
};

const updateLeadOwnerTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; to_owner: string }, MutationPreview | { ok: true; updated: number; errors: string[] }> = {
  name: 'update_lead_owner',
  description: 'Bulk reassign owner to a team member (by name, email, or UUID; "me" resolves to current user).',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      to_owner: { type: 'string', description: 'Team member name, email, UUID, or "me"' },
    },
    required: ['to_owner'],
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    to_owner: z.string().min(1),
  }).parse(raw),
  preview: async (args, ctx): Promise<MutationPreview> => {
    const owner = await resolveTeamMember(args.to_owner, ctx.teamMemberId);
    if (!owner) return { summary: `Could not resolve owner "${args.to_owner}"`, affected: [], warnings: [`unknown team member: ${args.to_owner}`] };
    const names = await teamMemberNames();
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const affected: PreviewRow[] = leads
      .filter(l => l.owned_by !== owner.id)
      .map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: l.owned_by ? names[l.owned_by] || 'unknown' : 'unassigned', after: owner.name }));
    return {
      summary: `Reassign ${affected.length} lead${affected.length === 1 ? '' : 's'} to ${owner.name}`,
      affected,
      warnings: ident.errors.length ? ident.errors : undefined,
    };
  },
  execute: async (args, ctx) => {
    const owner = await resolveTeamMember(args.to_owner, ctx.teamMemberId);
    if (!owner) throw new Error(`unknown team member: ${args.to_owner}`);
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    if (!ident.ids.length) return { ok: true, updated: 0, errors: ident.errors };
    const supabase = createAdminClient();
    const { error } = await supabase.from('leads').update({ owned_by: owner.id }).in('id', ident.ids);
    if (error) throw new Error(error.message);
    return { ok: true, updated: ident.ids.length, errors: ident.errors };
  },
};

const tagsTool = (mode: 'add' | 'remove'): ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; tags: string[] }, MutationPreview | { ok: true; updated: number; errors: string[] }> => ({
  name: mode === 'add' ? 'add_tags' : 'remove_tags',
  description: mode === 'add' ? 'Add one or more tags to a set of leads.' : 'Remove one or more tags from a set of leads.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['tags'],
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    tags: z.array(z.string().min(1)).min(1),
  }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const affected: PreviewRow[] = leads.map(l => {
      const cur = (l.tags || []) as string[];
      const target = mode === 'add' ? [...new Set([...cur, ...args.tags])] : cur.filter(t => !args.tags.includes(t));
      return { lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: cur.join(', ') || '(no tags)', after: target.join(', ') || '(no tags)' };
    });
    return {
      summary: `${mode === 'add' ? 'Add' : 'Remove'} tags [${args.tags.join(', ')}] on ${affected.length} lead${affected.length === 1 ? '' : 's'}`,
      affected,
      warnings: ident.errors.length ? ident.errors : undefined,
    };
  },
  execute: async (args) => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    if (!ident.ids.length) return { ok: true, updated: 0, errors: ident.errors };
    const supabase = createAdminClient();
    const { data: leads } = await supabase.from('leads').select('id, tags').in('id', ident.ids);
    let updated = 0;
    for (const l of leads || []) {
      const cur = (l.tags || []) as string[];
      const target = mode === 'add' ? [...new Set([...cur, ...args.tags])] : cur.filter(t => !args.tags.includes(t));
      const { error } = await supabase.from('leads').update({ tags: target }).eq('id', l.id);
      if (!error) updated++;
    }
    return { ok: true, updated, errors: ident.errors };
  },
});

const addNoteTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; text: string }, MutationPreview | { ok: true; created: number; errors: string[] }> = {
  name: 'add_note',
  description: 'Add a note interaction to one or more leads. Bulk-safe.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      text: { type: 'string' },
    },
    required: ['text'],
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    text: z.string().min(1),
  }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    const trimmed = args.text.length > 60 ? args.text.slice(0, 57) + '…' : args.text;
    return {
      summary: `Add note "${trimmed}" to ${leads.length} lead${leads.length === 1 ? '' : 's'}`,
      affected: leads.map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: '(no note)', after: trimmed })),
      warnings: ident.errors.length ? ident.errors : undefined,
    };
  },
  execute: async (args, ctx) => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const supabase = createAdminClient();
    let created = 0;
    for (const id of ident.ids) {
      const { error } = await supabase.from('interactions').insert({
        lead_id: id,
        type: 'note',
        body: args.text,
        team_member_id: ctx.teamMemberId,
        created_at: new Date().toISOString(),
      });
      if (!error) created++;
    }
    return { ok: true, created, errors: ident.errors };
  },
};

const pauseLeadsTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter; until?: string }, MutationPreview | { ok: true; paused: number; errors: string[] }> = {
  name: 'pause_leads',
  description: 'Move leads to paused stage, optionally with a paused_until date (ISO yyyy-mm-dd).',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
      until: { type: 'string', description: 'ISO date yyyy-mm-dd' },
    },
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    const leads = await fetchLeadsByIds(ident.ids);
    return {
      summary: `Pause ${leads.length} lead${leads.length === 1 ? '' : 's'}${args.until ? ` until ${args.until}` : ''}`,
      affected: leads.map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: l.stage, after: 'paused' })),
      warnings: ident.errors.length ? ident.errors : undefined,
      side_effects: ['Saves previous stage to paused_previous_stage; can be resumed via lead detail'],
    };
  },
  execute: async (args, ctx) => {
    const ident = await identifyLeads({ lead_ids: args.lead_ids, emails: args.emails, filter: args.filter });
    let paused = 0;
    const errors: string[] = [...ident.errors];
    for (const id of ident.ids) {
      const r = await changeStage(id, 'paused', ctx.teamMemberId);
      if (r.success) paused++;
      else errors.push(`${id}: ${r.error}`);
    }
    if (args.until && ident.ids.length) {
      const supabase = createAdminClient();
      await supabase.from('leads').update({ paused_until: args.until }).in('id', ident.ids);
    }
    return { ok: true, paused, errors };
  },
};

const markDeadTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter }, MutationPreview | { ok: true; killed: number; errors: string[] }> = {
  name: 'mark_dead',
  description: 'Move leads to dead stage. Dismisses pending follow-ups for those leads.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
    },
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
  }).refine(d => d.lead_ids?.length || d.emails?.length || d.filter, { message: 'must identify leads' }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads(args);
    const leads = await fetchLeadsByIds(ident.ids);
    return {
      summary: `Mark ${leads.length} lead${leads.length === 1 ? '' : 's'} as dead`,
      affected: leads.map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: l.stage, after: 'dead' })),
      warnings: ident.errors.length ? ident.errors : undefined,
      side_effects: ['Pending follow-ups are dismissed by the dead-stage hook.'],
    };
  },
  execute: async (args, ctx) => {
    const ident = await identifyLeads(args);
    let killed = 0;
    const errors: string[] = [...ident.errors];
    for (const id of ident.ids) {
      const r = await changeStage(id, 'dead', ctx.teamMemberId);
      if (r.success) killed++;
      else errors.push(`${id}: ${r.error}`);
    }
    return { ok: true, killed, errors };
  },
};

const archiveLeadsTool: ToolDef<{ lead_ids?: string[]; emails?: string[]; filter?: LeadFilter }, MutationPreview | { ok: true; archived: number; errors: string[] }> = {
  name: 'archive_leads',
  description: 'Soft-delete (is_archived=true) — hides from default views without losing data.',
  kind: 'mutation',
  jsonSchema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: filterJsonSchema,
    },
  },
  parse: raw => z.object({
    lead_ids: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    filter: leadFilterSchema.optional(),
  }).refine(d => d.lead_ids?.length || d.emails?.length || d.filter, { message: 'must identify leads' }).parse(raw),
  preview: async (args): Promise<MutationPreview> => {
    const ident = await identifyLeads(args);
    const leads = await fetchLeadsByIds(ident.ids);
    return {
      summary: `Archive ${leads.length} lead${leads.length === 1 ? '' : 's'}`,
      affected: leads.map(l => ({ lead_id: l.id, contact_name: l.contact_name, company_name: l.company_name, before: 'visible', after: 'archived' })),
      warnings: ident.errors.length ? ident.errors : undefined,
    };
  },
  execute: async (args) => {
    const ident = await identifyLeads(args);
    if (!ident.ids.length) return { ok: true, archived: 0, errors: ident.errors };
    const supabase = createAdminClient();
    const { error } = await supabase.from('leads').update({ is_archived: true }).in('id', ident.ids);
    if (error) throw new Error(error.message);
    return { ok: true, archived: ident.ids.length, errors: ident.errors };
  },
};

// ════════════════════════════════════════════════════════════════════
// Registry
// ════════════════════════════════════════════════════════════════════

export const TOOLS: Record<string, ToolDef> = {
  // Read
  find_leads: findLeadsTool as unknown as ToolDef,
  get_lead: getLeadTool as unknown as ToolDef,
  count_leads: countLeadsTool as unknown as ToolDef,
  recent_activity: recentActivityTool as unknown as ToolDef,
  export_csv: exportCsvTool as unknown as ToolDef,
  // Mutation
  move_leads_to_stage: moveLeadsToStageTool as unknown as ToolDef,
  update_lead_priority: updateLeadPriorityTool as unknown as ToolDef,
  update_lead_owner: updateLeadOwnerTool as unknown as ToolDef,
  add_tags: tagsTool('add') as unknown as ToolDef,
  remove_tags: tagsTool('remove') as unknown as ToolDef,
  add_note: addNoteTool as unknown as ToolDef,
  pause_leads: pauseLeadsTool as unknown as ToolDef,
  mark_dead: markDeadTool as unknown as ToolDef,
  archive_leads: archiveLeadsTool as unknown as ToolDef,
};

// JSON-schema definitions for the LLM tools[] payload.
export function toolsForLLM(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return Object.values(TOOLS).map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));
}

export const BULK_HARD_CAP = 25;     // > this, UI requires typed-confirm
export const _identifyLeadsForTest = identifyLeads;
export type { IdentifyArgs };
