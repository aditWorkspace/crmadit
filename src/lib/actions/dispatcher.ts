import { createAdminClient } from '@/lib/supabase/admin';
import { TOOLS } from './tools';
import type { ToolContext, MutationPreview, ReadResult } from './types';

// Outcomes the dispatcher returns to the orchestrator.
export type ToolOutcome =
  | { kind: 'read'; tool_call_id: string; tool_name: string; data: ReadResult; raw_for_llm: string }
  | { kind: 'mutation_preview'; tool_call_id: string; tool_name: string; pending_id: string; preview: MutationPreview; raw_for_llm: string }
  | { kind: 'mutation_result'; tool_call_id: string; tool_name: string; data: unknown; raw_for_llm: string }
  | { kind: 'error'; tool_call_id: string; tool_name: string; error: string; raw_for_llm: string };

// Run a single tool call coming from the LLM. For read tools we execute
// immediately. For mutations we build a preview and persist a pending row;
// the user must call confirmPending() to actually execute.
export async function runToolCall(args: {
  tool_call_id: string;
  tool_name: string;
  raw_args: unknown;
  ctx: ToolContext;
  session_id: string;
  message_id: string;
}): Promise<ToolOutcome> {
  const tool = TOOLS[args.tool_name];
  if (!tool) {
    const msg = `unknown tool: ${args.tool_name}`;
    return { kind: 'error', tool_call_id: args.tool_call_id, tool_name: args.tool_name, error: msg, raw_for_llm: JSON.stringify({ error: msg }) };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = tool.parse(args.raw_args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid args';
    return { kind: 'error', tool_call_id: args.tool_call_id, tool_name: args.tool_name, error: msg, raw_for_llm: JSON.stringify({ error: msg }) };
  }

  if (tool.kind === 'read') {
    try {
      const data = (await tool.execute(parsedArgs as never, args.ctx)) as ReadResult;
      return {
        kind: 'read',
        tool_call_id: args.tool_call_id,
        tool_name: args.tool_name,
        data,
        raw_for_llm: stringifyForLLM(data),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'execution failed';
      return { kind: 'error', tool_call_id: args.tool_call_id, tool_name: args.tool_name, error: msg, raw_for_llm: JSON.stringify({ error: msg }) };
    }
  }

  // Mutation: preview + persist pending row.
  try {
    if (!tool.preview) throw new Error(`tool ${args.tool_name} missing preview()`);
    const preview = await tool.preview(parsedArgs as never, args.ctx);
    const supabase = createAdminClient();
    const { data: pending, error } = await supabase
      .from('action_chat_pending')
      .insert({
        session_id: args.session_id,
        message_id: args.message_id,
        tool_name: args.tool_name,
        args: parsedArgs as Record<string, unknown>,
        preview,
        team_member_id: args.ctx.teamMemberId,
      })
      .select('id')
      .single();
    if (error || !pending) throw new Error(error?.message || 'failed to persist pending');
    return {
      kind: 'mutation_preview',
      tool_call_id: args.tool_call_id,
      tool_name: args.tool_name,
      pending_id: pending.id,
      preview,
      raw_for_llm: JSON.stringify({
        kind: 'mutation_pending',
        pending_id: pending.id,
        summary: preview.summary,
        affected_count: preview.affected.length,
        warnings: preview.warnings,
        note: 'Action requires user confirmation. Do NOT call this tool again — wait for the user.',
      }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'preview failed';
    return { kind: 'error', tool_call_id: args.tool_call_id, tool_name: args.tool_name, error: msg, raw_for_llm: JSON.stringify({ error: msg }) };
  }
}

// Confirm a previously-previewed pending action. Idempotent: confirming
// twice returns the cached result instead of re-running.
export async function confirmPending(pending_id: string, teamMemberId: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const supabase = createAdminClient();
  const { data: pending, error } = await supabase
    .from('action_chat_pending')
    .select('*')
    .eq('id', pending_id)
    .single();
  if (error || !pending) return { ok: false, error: 'pending action not found' };
  if (pending.team_member_id !== teamMemberId) return { ok: false, error: 'not your pending action' };
  if (pending.status === 'confirmed') return { ok: true, result: pending.result };
  if (pending.status === 'cancelled' || pending.status === 'expired') return { ok: false, error: `pending action is ${pending.status}` };
  if (new Date(pending.expires_at) < new Date()) {
    await supabase.from('action_chat_pending').update({ status: 'expired' }).eq('id', pending_id);
    return { ok: false, error: 'pending action expired' };
  }

  const tool = TOOLS[pending.tool_name];
  if (!tool) return { ok: false, error: `unknown tool ${pending.tool_name}` };

  // Lock-then-execute: mark confirmed BEFORE running, so a double-click
  // can't double-execute. If execute() throws we revert to pending so the
  // user can retry.
  const lockNow = new Date().toISOString();
  const lock = await supabase
    .from('action_chat_pending')
    .update({ status: 'confirmed', executed_at: lockNow })
    .eq('id', pending_id)
    .eq('status', 'pending');
  if (lock.error) return { ok: false, error: lock.error.message };

  try {
    const ctx: ToolContext = { teamMemberId, teamMemberName: '' };
    const result = await tool.execute(pending.args as never, ctx);
    await supabase
      .from('action_chat_pending')
      .update({ result: result as Record<string, unknown> })
      .eq('id', pending_id);
    return { ok: true, result };
  } catch (e) {
    await supabase.from('action_chat_pending').update({ status: 'pending', executed_at: null }).eq('id', pending_id);
    return { ok: false, error: e instanceof Error ? e.message : 'execution failed' };
  }
}

export async function cancelPending(pending_id: string, teamMemberId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: pending } = await supabase.from('action_chat_pending').select('id, team_member_id, status').eq('id', pending_id).single();
  if (!pending) return { ok: false, error: 'not found' };
  if (pending.team_member_id !== teamMemberId) return { ok: false, error: 'not your pending action' };
  if (pending.status !== 'pending') return { ok: false, error: `cannot cancel; status=${pending.status}` };
  const { error } = await supabase.from('action_chat_pending').update({ status: 'cancelled' }).eq('id', pending_id);
  return { ok: !error, error: error?.message };
}

// Compact stringification for the LLM tool-result message. The LLM does
// not need full lead lists for every read; it needs the summary so it can
// reason about next steps. We send the structured result but cap arrays.
function stringifyForLLM(data: ReadResult): string {
  if (data.kind === 'lead_list') {
    return JSON.stringify({
      kind: 'lead_list',
      total: data.total,
      shown: Math.min(data.leads.length, 10),
      leads: data.leads.slice(0, 10).map(l => ({ id: l.id, name: l.contact_name, email: l.contact_email, company: l.company_name, stage: l.stage, priority: l.priority, owner: l.owned_by_name, last_contact: l.last_contact_at })),
    });
  }
  if (data.kind === 'lead_detail') {
    return JSON.stringify({ kind: 'lead_detail', lead: data.lead });
  }
  if (data.kind === 'count') {
    return JSON.stringify({ kind: 'count', total: data.total, breakdown: data.breakdown });
  }
  if (data.kind === 'activity') {
    return JSON.stringify({ kind: 'activity', count: data.entries.length, entries: data.entries.slice(0, 10) });
  }
  if (data.kind === 'csv') {
    return JSON.stringify({ kind: 'csv', filename: data.filename, row_count: data.row_count, url_present: true });
  }
  return JSON.stringify(data);
}
