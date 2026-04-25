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
      throw new Error(`OpenRouter API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from OpenRouter');

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
