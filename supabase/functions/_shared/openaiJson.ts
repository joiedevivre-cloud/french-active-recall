// One Structured-Outputs chat call, shared by analyze-lemma, admin-prompts
// and scripts/backfill-analysis.ts (runs on Deno and Node 24 -- only uses
// global fetch). The API key is passed in by the caller and only ever goes
// into the outgoing Authorization header; error messages include OpenAI's
// error body (which never contains the key) but never the prompt or input.

export interface OpenAiJsonResult {
  parsed: unknown;
  inputTokens: number;
  outputTokens: number;
}

export async function callOpenAIJsonSchema(options: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  schema: unknown;
  schemaName: string;
  maxOutputTokens: number;
  temperature?: number | null;
}): Promise<OpenAiJsonResult> {
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxOutputTokens,
    response_format: { type: 'json_schema', json_schema: { name: options.schemaName, strict: true, schema: options.schema } },
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
    ],
  };
  // null/undefined = OpenAI's default (what every call used before prompt management)
  if (typeof options.temperature === 'number') body.temperature = options.temperature;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`openai_http_${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('openai_empty_response');
  if (choice?.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error(`output_truncated: finish_reason=${choice.finish_reason}, length=${content.length}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`invalid_json: length=${content.length}`);
  }

  return {
    parsed,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
  };
}
