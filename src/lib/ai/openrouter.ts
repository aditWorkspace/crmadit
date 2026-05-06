const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324';
const DEFAULT_MAX_TOKENS = 2000;

export interface AiCallParams {
  systemPrompt: string;
  userMessage: string;
  jsonMode?: boolean;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCallMessagesParams {
  messages: AiMessage[];
  jsonMode?: boolean;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  // Try these models in order if `model` returns 429 (rate limit) or 5xx.
  // Cheap insurance against upstream provider blips on a single model.
  fallbackModels?: string[];
}

export async function callAI(params: AiCallParams): Promise<string> {
  return callAIMessages({
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userMessage },
    ],
    jsonMode: params.jsonMode,
    model: params.model,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
  });
}

// Full messages-array variant. Use when you need conversation history,
// multi-turn assistant replies, or any system+user+assistant interleaving.
export async function callAIMessages(params: AiCallMessagesParams): Promise<string> {
  const candidates = [params.model || DEFAULT_MODEL, ...(params.fallbackModels || [])];
  let lastErr: Error | null = null;

  for (const model of candidates) {
    try {
      return await singleAttempt({ ...params, model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err instanceof Error ? err : new Error(message);
      // Retryable: 429 (rate limit) or 5xx (server error). Anything else is
      // a permanent failure (bad model id, auth, malformed payload) that
      // would fail on every fallback the same way — bail immediately.
      const retryable =
        /API error (429|5\d\d)/.test(message) ||
        /empty response/i.test(message);
      if (!retryable) throw lastErr;
      console.warn(`[openrouter] ${model} failed (${message.slice(0, 100)}), trying next fallback`);
    }
  }
  throw lastErr ?? new Error('OpenRouter call failed with no specific error');
}

async function singleAttempt(params: AiCallMessagesParams): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 55_000);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Proxi CRM',
      },
      body: JSON.stringify({
        model: params.model || DEFAULT_MODEL,
        max_tokens: params.maxTokens || DEFAULT_MAX_TOKENS,
        messages: params.messages,
        ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      // Distinguish a credits-depleted 402 from a transient API error so
      // the chat UI can show a clean "top up credits" message instead of
      // dumping a raw stacktrace at the user.
      if (response.status === 402) {
        const e = new Error('OpenRouter credits depleted — add credits at https://openrouter.ai/settings/credits');
        (e as Error & { code?: string }).code = 'OPENROUTER_CREDITS_DEPLETED';
        throw e;
      }
      throw new Error(`OpenRouter API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(
        `Empty response from OpenRouter (model=${params.model || DEFAULT_MODEL})`,
      );
    }

    // Strip markdown code fences if the model wraps JSON in ```json ... ```
    if (params.jsonMode) {
      content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    }

    return content;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('OpenRouter request timed out after 55 seconds');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
