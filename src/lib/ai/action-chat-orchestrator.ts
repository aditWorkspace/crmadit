import { createAdminClient } from '@/lib/supabase/admin';
import { toolsForLLM } from '@/lib/actions/tools';
import { runToolCall } from '@/lib/actions/dispatcher';
import type { ToolOutcome } from '@/lib/actions/dispatcher';

// Action-chat orchestrator. Calls OpenRouter with tools[] enabled, runs
// every read tool in-loop, and STOPS when a mutation is previewed (the
// user has to confirm in the UI before the next round).

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PRIMARY_MODEL = 'deepseek/deepseek-v4-pro';
const FALLBACK_MODELS = ['anthropic/claude-sonnet-4.6', 'deepseek/deepseek-v4-flash'];
const MAX_TOOL_LOOPS = 6;          // safety cap on read-tool chains

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

  const tools = toolsForLLM();
  const tool_outcomes: ToolOutcome[] = [];
  const supabase = createAdminClient();
  const persisted_message_ids: string[] = [];
  let final_text = '';

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const completion = await callWithFallback(messages, tools);
    const assistantMsg = completion.choices?.[0]?.message;
    if (!assistantMsg) {
      final_text = '(no response)';
      break;
    }

    const text = (assistantMsg.content as string) || '';
    const toolCalls = assistantMsg.tool_calls as ChatMessageIn['tool_calls'] | undefined;

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

async function callWithFallback(
  messages: ChatMessageIn[],
  tools: ReturnType<typeof toolsForLLM>,
): Promise<{ choices: Array<{ message: { content: string; tool_calls?: unknown } }> }> {
  const candidates = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      return await singleCall(model, messages, tools);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = e instanceof Error ? e : new Error(msg);
      const retryable = /API error (429|5\d\d)/.test(msg);
      if (!retryable) throw lastErr;
      console.warn(`[action-chat] ${model} failed (${msg.slice(0, 100)}), trying next`);
    }
  }
  throw lastErr ?? new Error('all models failed');
}

async function singleCall(model: string, messages: ChatMessageIn[], tools: ReturnType<typeof toolsForLLM>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Proxi CRM Action Chat',
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        max_tokens: 1500,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Action-chat call timed out after 90s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
