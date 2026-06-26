import Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, isAnthropicModel, anthropicError } from './anthropic';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Default workhorse. Direct-Anthropic Haiku — used by callers that pass no
// model (transcript-processor, followup-drafter). `claude-*` ids route to the
// Anthropic API; non-claude ids (Gemini image gen) stay on OpenRouter.
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 2000;

// Image generation / editing (visual-outreach v2). These models output images
// in choices[0].message.images[] when called with modalities:["image","text"].
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
export const IMAGE_MODEL_FALLBACKS = ['google/gemini-2.5-flash-image', 'openai/gpt-5.4-image-2'];

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

// Strip markdown code fences a model may wrap JSON in, and — if there's
// leading/trailing prose — extract the outermost {...} / [...] object. Best
// effort: callers still parse (some via tolerantJsonParse).
function stripJson(content: string): string {
  let c = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  if (!(c.startsWith('{') || c.startsWith('['))) {
    const obj = c.indexOf('{');
    const arr = c.indexOf('[');
    const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
    if (start > 0) {
      const end = Math.max(c.lastIndexOf('}'), c.lastIndexOf(']'));
      if (end > start) c = c.slice(start, end + 1).trim();
    }
  }
  return c;
}

// Direct-Anthropic text call. Anthropic puts `system` at the top level (not a
// message role) and has no `response_format` — so we hoist system messages out
// and, for jsonMode, instruct + post-strip instead.
async function anthropicTextAttempt(params: AiCallMessagesParams & { model: string }): Promise<string> {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else messages.push({ role: m.role, content: m.content });
  }
  let system = systemParts.join('\n\n');
  if (params.jsonMode) {
    system = `${system ? system + '\n\n' : ''}Output ONLY valid JSON — no markdown code fences, no commentary before or after.`;
  }
  try {
    const resp = await getAnthropic().messages.create(
      {
        model: params.model,
        max_tokens: params.maxTokens || DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
      },
      { timeout: params.timeoutMs ?? 55_000 },
    );
    let content = resp.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    if (!content) throw new Error(`Empty response from Anthropic (model=${params.model})`);
    if (params.jsonMode) content = stripJson(content);
    return content;
  } catch (err) {
    throw anthropicError(err);
  }
}

async function singleAttempt(params: AiCallMessagesParams): Promise<string> {
  const model = params.model || DEFAULT_MODEL;
  if (isAnthropicModel(model)) return anthropicTextAttempt({ ...params, model });

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

// ── Image generation / editing ─────────────────────────────────────────────

export interface ImageGenParams {
  prompt: string;
  /** Base64 data URLs (data:image/png;base64,...) of reference image(s) to
   *  edit. Omit for pure text-to-image. */
  referenceImages?: string[];
  model?: string;
  fallbackModels?: string[];
  /** 0..1 — lower keeps the output closer to the reference image (face/scene
   *  preservation); only meaningful when referenceImages is set. */
  strength?: number;
  timeoutMs?: number;
}

/**
 * Generate (or edit) an image via OpenRouter and return a base64 PNG data URL
 * (the raw `choices[0].message.images[0].image_url.url`). Mirrors callAIMessages'
 * fallback ladder: a 429/5xx/empty-image on one model falls through to the next.
 */
export async function generateImage(params: ImageGenParams): Promise<string> {
  const candidates = [params.model || DEFAULT_IMAGE_MODEL, ...(params.fallbackModels || IMAGE_MODEL_FALLBACKS)];
  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      return await singleImageAttempt({ ...params, model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err instanceof Error ? err : new Error(message);
      const retryable =
        /API error (429|5\d\d)/.test(message) ||
        /no image in response/i.test(message);
      if (!retryable) throw lastErr;
      console.warn(`[openrouter-image] ${model} failed (${message.slice(0, 100)}), trying next fallback`);
    }
  }
  throw lastErr ?? new Error('OpenRouter image gen failed with no specific error');
}

/**
 * Vision read: send a text prompt + one image and return the model's TEXT
 * answer (choices[0].message.content). Used to validate text on a generated
 * image (e.g. the company name on a whiteboard). Best-effort — callers should
 * treat a throw as "couldn't check", never a hard failure.
 */
// Turn a data: URL (or http URL) into an Anthropic image source block.
function anthropicImageSource(imageDataUrl: string): Anthropic.ImageBlockParam['source'] {
  const m = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/);
  if (m) {
    return { type: 'base64', media_type: m[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: m[2] };
  }
  return { type: 'url', url: imageDataUrl };
}

async function anthropicVisionAttempt(params: { prompt: string; imageDataUrl: string; model: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
  const resp = await getAnthropic().messages.create(
    {
      model: params.model,
      max_tokens: params.maxTokens ?? 80,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: anthropicImageSource(params.imageDataUrl) },
          { type: 'text', text: params.prompt },
        ],
      }],
    },
    { timeout: params.timeoutMs ?? 30_000 },
  );
  return resp.content.map(b => (b.type === 'text' ? b.text : '')).join('');
}

export async function callVision(params: { prompt: string; imageDataUrl: string; model?: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
  const model = params.model || 'claude-haiku-4-5';
  if (isAnthropicModel(model)) return anthropicVisionAttempt({ ...params, model });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000);
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
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: params.prompt },
          { type: 'image_url', image_url: { url: params.imageDataUrl } },
        ] }],
        max_tokens: params.maxTokens ?? 80,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter vision error ${response.status}`);
    const data = await response.json();
    return String(data.choices?.[0]?.message?.content ?? '');
  } finally {
    clearTimeout(timeout);
  }
}

async function singleImageAttempt(params: ImageGenParams & { model: string }): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 90_000);

  // content = the text prompt followed by any reference images to edit.
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: params.prompt }];
  for (const img of params.referenceImages ?? []) {
    content.push({ type: 'image_url', image_url: { url: img } });
  }

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
        model: params.model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
        ...(params.strength != null ? { image_config: { strength: params.strength } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 402) {
        const e = new Error('OpenRouter credits depleted — add credits at https://openrouter.ai/settings/credits');
        (e as Error & { code?: string }).code = 'OPENROUTER_CREDITS_DEPLETED';
        throw e;
      }
      throw new Error(`OpenRouter API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url) {
      throw new Error(`No image in response (model=${params.model})`);
    }
    return url;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('OpenRouter image request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Account credit balance ──────────────────────────────────────────────────

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

/**
 * Fetch the remaining OpenRouter credit balance in USD-equivalent credits
 * (total_credits − total_usage). Returns null if the key is unset or the call
 * fails — callers MUST treat null as "couldn't check", never as "empty", so a
 * transient blip doesn't fire a false alarm.
 */
export async function getOpenRouterCreditsRemaining(timeoutMs = 10_000): Promise<number | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_CREDITS_URL, {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const total = Number(data?.data?.total_credits);
    const used = Number(data?.data?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
    return total - used;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
