const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface AiCallParams {
  systemPrompt: string;
  userMessage: string;
  jsonMode?: boolean;
  model?: string;
}

export async function callAI(params: AiCallParams): Promise<string> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Proxi CRM',
    },
    body: JSON.stringify({
      model: params.model || 'anthropic/claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userMessage },
      ],
      ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenRouter');
  return content;
}
