import Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/supabase/admin';
import { toolsForLLM } from '@/lib/actions/tools';
import { runToolCall } from '@/lib/actions/dispatcher';
import type { ToolOutcome } from '@/lib/actions/dispatcher';
import { getAnthropic, anthropicError } from './anthropic';

// Action-chat orchestrator. Calls the Anthropic API directly (native tool-use)
// with tools[] enabled, runs every read tool in-loop, and STOPS when a mutation
// is previewed (the user has to confirm in the UI before the next round).

const PRIMARY_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODELS = ['claude-haiku-4-5'];
const MAX_TOOL_LOOPS = 6;          // safety cap on read-tool chains
const MAX_OUTPUT_TOKENS = 2000;

const SYSTEM_PROMPT = `You are the Action Chat assistant for the Proxi AI CRM. The founder uses you to find, count, export, and bulk-update leads via natural language.

You have a set of tools. Use them. Do NOT answer from imagination — every factual statement about leads must come from a tool result.

GROUND RULES:

1. **Read tools** (find_leads, get_lead, count_leads, recent_activity, export_csv) execute immediately and return data. Use them freely.

2. **Mutation tools** (move_leads_to_stage, update_lead_priority, update_lead_owner, add_tags, remove_tags, add_note, pause_leads, mark_dead, archive_leads) are PREVIEW-then-CONFIRM. When you call one, the system builds a preview and shows it to the user as a confirmation card. The user clicks Confirm or Cancel — you do NOT execute mutations directly. After invoking a mutation tool, your turn is over; do not call it again, do not call other mutations in the same turn.

3. **Identifying leads**: every mutation tool accepts \`lead_ids\`, \`emails\`, OR \`filter\`. Prefer emails when the user gives them; use a filter when they describe a group ("everyone in scheduling Adit owns"); use lead_ids only when you got them from a previous tool call. Never guess UUIDs.

4. **Ambiguity resolution**: if the user says "Roop" and the find_leads tool returns multiple matches, ask the user which one — do NOT pick.

5. **Bulk safety**: if a mutation would affect more than 25 leads, the UI will require a typed confirmation. Tell the user that's coming so they're not surprised.

6. **Refuse what you can't do**: if the user asks for something outside your tool catalog (e.g. send an email, edit a transcript, change pricing), say so plainly. Do not hallucinate a workaround.

7. **Be concise**: the founder is busy. State what you're doing in one sentence, run the tool, summarize the result. Skip preambles.

8. **When unsure, ask before acting**. A clarifying question is always better than a wrong mutation.`;

interface ChatMessageIn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;                 // raw text
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;           // for role=tool
}

export interface RunResult {
  // Final assistant text shown to user.
  final_text: string;
  // Tool outcomes encountered during this run, in order. The UI renders
  // these inline (read results + mutation preview cards).
  tool_outcomes: ToolOutcome[];
  // Raw assistant message rows we should persist.
  persisted_message_ids: string[];
}

interface RunArgs {
  session_id: string;
  user_message_id: string;
  history: ChatMessageIn[];        // prior conversation, oldest first
  current_user_text: string;
  ctx: { teamMemberId: string; teamMemberName: string };
}

export async function runActionChat(args: RunArgs): Promise<RunResult> {
  const messages: ChatMessageIn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...args.history,
    { role: 'user', content: args.current_user_text },
  ];

  const tools = toAnthropicTools(toolsForLLM());
  const tool_outcomes: ToolOutcome[] = [];
  const supabase = createAdminClient();
  const persisted_message_ids: string[] = [];
  let final_text = '';

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const { text, toolUses } = await callWithFallback(messages, tools);
    // Re-encode the model's tool_use blocks into our stored OpenAI-shaped
    // tool_calls so persistence + history reconstruction stay unchanged.
    const toolCalls: ChatMessageIn['tool_calls'] = toolUses.length
      ? toolUses.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }))
      : undefined;

    // Persist the assistant turn (text + tool_calls).
    const { data: assistantRow } = await supabase
      .from('action_chat_messages')
      .insert({
        session_id: args.session_id,
        role: 'assistant',
        content: { text, tool_calls: toolCalls ?? [] },
      })
      .select('id')
      .single();
    if (assistantRow) persisted_message_ids.push(assistantRow.id);

    // Echo back to LLM history.
    messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });

    if (!toolCalls?.length) {
      final_text = text;
      break;
    }

    // Run each tool call. If any are mutations -> previews -> stop loop;
    // user must confirm before the LLM continues. If all are reads, we
    // append results and loop again so the LLM can summarize.
    let sawMutation = false;
    const messageIdForTools = assistantRow?.id ?? args.user_message_id;
    for (const tc of toolCalls) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        parsed = {};
      }
      const outcome = await runToolCall({
        tool_call_id: tc.id,
        tool_name: tc.function.name,
        raw_args: parsed,
        ctx: args.ctx,
        session_id: args.session_id,
        message_id: messageIdForTools,
      });
      tool_outcomes.push(outcome);

      // Persist the tool result row.
      const { data: toolRow } = await supabase
        .from('action_chat_messages')
        .insert({
          session_id: args.session_id,
          role: 'tool',
          content: { tool_call_id: tc.id, tool_name: tc.function.name, outcome },
        })
        .select('id')
        .single();
      if (toolRow) persisted_message_ids.push(toolRow.id);

      // Feed the tool result back to the LLM for the next loop iteration.
      messages.push({
        role: 'tool',
        content: outcome.raw_for_llm,
        tool_call_id: tc.id,
      });

      if (outcome.kind === 'mutation_preview') sawMutation = true;
    }

    if (sawMutation) {
      // The UI will now show a confirmation card. Stop the loop — the LLM
      // doesn't get another turn until the user responds.
      final_text = text || '(see confirmation card)';
      break;
    }
    // All reads — loop so the LLM can summarize the data.
  }

  return { final_text, tool_outcomes, persisted_message_ids };
}

type AnthropicToolUse = { id: string; name: string; input: unknown };

// Our tools[] are OpenAI-shaped ({type:'function', function:{name,description,
// parameters}}); Anthropic wants {name, description, input_schema} — the JSON
// schema body is identical, just renamed.
function toAnthropicTools(tools: ReturnType<typeof toolsForLLM>): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool['input_schema'],
  }));
}

// Translate our OpenAI-shaped ChatMessageIn history into Anthropic's format:
// system is hoisted to the top level; assistant tool_calls become tool_use
// blocks; consecutive role:'tool' results are grouped into the single user turn
// that must follow their assistant turn.
function toAnthropicMessages(history: ChatMessageIn[]): { system: string; messages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const m of history) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }
    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(no output)' }] });
      continue;
    }
    if (m.role === 'tool') {
      const block: Anthropic.ContentBlockParam = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content && m.content.trim() ? m.content : '(no output)',
      };
      const last = messages[messages.length - 1];
      const lastBlocks = last && last.role === 'user' && Array.isArray(last.content)
        ? (last.content as Anthropic.ContentBlockParam[]) : null;
      if (lastBlocks && lastBlocks[0]?.type === 'tool_result') lastBlocks.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    // plain user turn
    messages.push({ role: 'user', content: m.content });
  }
  return { system: systemParts.join('\n\n'), messages };
}

async function callWithFallback(
  history: ChatMessageIn[],
  tools: Anthropic.Tool[],
): Promise<{ text: string; toolUses: AnthropicToolUse[] }> {
  const { system, messages } = toAnthropicMessages(history);
  const candidates = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      const resp = await getAnthropic().messages.create(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(system ? { system } : {}),
          tools,
          messages,
        },
        { timeout: 90_000 },
      );
      const text = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
      const toolUses: AnthropicToolUse[] = resp.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input }));
      return { text, toolUses };
    } catch (e) {
      lastErr = anthropicError(e);
      const retryable = /API error (429|5\d\d)/.test(lastErr.message);
      if (!retryable) throw lastErr;
      console.warn(`[action-chat] ${model} failed (${lastErr.message.slice(0, 100)}), trying next`);
    }
  }
  throw lastErr ?? new Error('all models failed');
}
