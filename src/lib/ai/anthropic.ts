import Anthropic from '@anthropic-ai/sdk';

// Direct Anthropic API client. We call api.anthropic.com directly (not via
// OpenRouter) so our Anthropic credits are what get consumed. Models whose id
// starts with `claude-` route here; everything else (Gemini image gen, etc.)
// still goes through OpenRouter in openrouter.ts.

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** A direct-Anthropic model id (e.g. `claude-haiku-4-5`, `claude-sonnet-4-6`).
 *  OpenRouter-style `anthropic/claude-*` strings deliberately do NOT match —
 *  those would bill OpenRouter, which is exactly what this migration removes. */
export function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-');
}

/** Map an Anthropic SDK error to the `API error <status>` message shape that
 *  callAIMessages / the action-chat fallback ladder already pattern-match on
 *  (`/API error (429|5\d\d)/`). Non-API errors pass through unchanged so their
 *  own messages (e.g. "Empty response", "timed out") still drive retry logic. */
export function anthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return new Error(`API error ${err.status}: ${String(err.message ?? '').slice(0, 300)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
