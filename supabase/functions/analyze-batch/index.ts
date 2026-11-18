// Supabase Edge Function: analyze-batch
//
// Analyzes a CHUNK (1-20) of not-yet-saved French sentences for the "AI 일괄
// 분석" feature (src/features/ai-batch/). Unlike analyze-expression (which
// enriches an expression that's already in the DB), this function never
// writes to expressions/expression_examples itself -- it only returns
// structured analysis for the client to show in a review screen before the
// user decides what to save. The client is responsible for chunking the
// full 1-100 sentence input into calls like this one and showing progress.
//
// Same security requirements as analyze-expression (see
// docs/Claude_프랑스어앱_개발보안지시서.docx): server-side JWT verification,
// global kill switch, 1 concurrent request per user, per-user daily rate
// limits + budget caps, capped input size, OpenAI key never leaves this
// function's environment.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const MAX_CHUNK_SIZE = 20;

// Each result item carries ~9 fields of Korean/French text. A FIXED
// max_tokens regardless of chunk size (the old bug: always 1024,
// whatever ai_rate_limits.max_output_tokens said) meant any chunk bigger
// than ~3-4 sentences could never finish within budget -- OpenAI stops
// generating mid-string (finish_reason: 'length') and the truncated text
// is simply not valid JSON. This is a generous-but-bounded per-item
// estimate, not a tight one; MAX_TOTAL_OUTPUT_TOKENS is a hard ceiling
// independent of whatever a user's ai_rate_limits row says, so a
// misconfigured/very high row can never request an enormous completion.
const TOKENS_PER_ITEM_ESTIMATE = 350;
// The detailed (sentence_structure/grammar_points/vocabulary/
// common_mistakes/similar_expressions/example_sentences) schema is far
// bigger per item -- gated to exactly 1 sentence per request (see
// MAX_DETAILED_SENTENCES below) specifically so this large per-item cost
// never has to multiply across a chunk.
const DETAILED_TOKENS_PER_ITEM_ESTIMATE = 1800;
const OUTPUT_TOKEN_OVERHEAD = 200;
const MAX_TOTAL_OUTPUT_TOKENS = 4000;
const MAX_DETAILED_SENTENCES = 1;

function computeMaxOutputTokens(sentenceCount: number, configuredCeiling: number, detailed: boolean): number {
  const perItem = detailed ? DETAILED_TOKENS_PER_ITEM_ESTIMATE : TOKENS_PER_ITEM_ESTIMATE;
  const estimated = sentenceCount * perItem + OUTPUT_TOKEN_OVERHEAD;
  return Math.min(estimated, MAX_TOTAL_OUTPUT_TOKENS, configuredCeiling);
}

// Approximate OpenAI pricing (USD per 1M tokens). VERIFY against
// https://openai.com/api/pricing -- this is only as accurate as the last
// time someone updated it here.
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

interface BatchItemResult {
  expression_fr: string;
  corrected_fr: string | null;
  meaning_ko: string;
  grammar_note: string;
  example_fr: string;
  example_translation_ko: string;
  cefr_level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  tags: string[];
  key_phrase: string;
}

interface SentenceStructure {
  main_clause: string;
  conjunction: string;
  subordinate_clause: string;
  core_structure: string;
  infinitive: string;
  conjugated_form: string;
  mood_explanation: string;
  mood_contrast: string;
  overall_meaning: string;
}

interface VocabularyItem {
  word: string;
  part_of_speech: string;
  meaning_ko: string;
  infinitive: string | null;
  tense_or_conjugation: string | null;
  gender_agreement: string | null;
  preposition: string | null;
  common_mistake: string | null;
}

interface DetailedBatchItemResult extends BatchItemResult {
  sentence_structure: SentenceStructure | null;
  grammar_points: { pattern: string; meaning: string; example: string }[];
  vocabulary: VocabularyItem[];
  common_mistakes: string[];
  similar_expressions: { a: string; b: string; difference: string }[];
  example_sentences: { fr: string; ko: string }[];
}

const LIGHT_RESULT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    expression_fr: { type: 'string' },
    corrected_fr: { type: ['string', 'null'] },
    meaning_ko: { type: 'string' },
    grammar_note: { type: 'string' },
    example_fr: { type: 'string' },
    example_translation_ko: { type: 'string' },
    cefr_level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
    tags: { type: 'array', items: { type: 'string' } },
    key_phrase: { type: 'string' },
  },
  required: [
    'expression_fr',
    'corrected_fr',
    'meaning_ko',
    'grammar_note',
    'example_fr',
    'example_translation_ko',
    'cefr_level',
    'tags',
    'key_phrase',
  ],
  additionalProperties: false,
};

// Only used when detailed=true (see below) -- a SINGLE sentence at a time.
// Deliberately NOT part of the light/bulk schema: every field here adds a
// lot of Korean-heavy output, and this is exactly the kind of per-item
// cost growth that caused the max_tokens truncation bug when it was
// implicitly applied to a whole multi-sentence chunk. Keeping this gated
// to one sentence per request means the token budget never has to scale
// with chunk size for this schema at all.
const SENTENCE_STRUCTURE_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    main_clause: { type: 'string' },
    conjunction: { type: 'string' },
    subordinate_clause: { type: 'string' },
    core_structure: { type: 'string' },
    infinitive: { type: 'string' },
    conjugated_form: { type: 'string' },
    mood_explanation: { type: 'string' },
    mood_contrast: { type: 'string' },
    overall_meaning: { type: 'string' },
  },
  required: [
    'main_clause',
    'conjunction',
    'subordinate_clause',
    'core_structure',
    'infinitive',
    'conjugated_form',
    'mood_explanation',
    'mood_contrast',
    'overall_meaning',
  ],
  additionalProperties: false,
};

const VOCABULARY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string' },
    part_of_speech: { type: 'string' },
    meaning_ko: { type: 'string' },
    infinitive: { type: ['string', 'null'] },
    tense_or_conjugation: { type: ['string', 'null'] },
    gender_agreement: { type: ['string', 'null'] },
    preposition: { type: ['string', 'null'] },
    common_mistake: { type: ['string', 'null'] },
  },
  required: ['word', 'part_of_speech', 'meaning_ko', 'infinitive', 'tense_or_conjugation', 'gender_agreement', 'preposition', 'common_mistake'],
  additionalProperties: false,
};

const GRAMMAR_POINT_SCHEMA = {
  type: 'object',
  properties: { pattern: { type: 'string' }, meaning: { type: 'string' }, example: { type: 'string' } },
  required: ['pattern', 'meaning', 'example'],
  additionalProperties: false,
};

const SIMILAR_EXPRESSION_SCHEMA = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, difference: { type: 'string' } },
  required: ['a', 'b', 'difference'],
  additionalProperties: false,
};

const EXAMPLE_SENTENCE_SCHEMA = {
  type: 'object',
  properties: { fr: { type: 'string' }, ko: { type: 'string' } },
  required: ['fr', 'ko'],
  additionalProperties: false,
};

const DETAILED_RESULT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    ...LIGHT_RESULT_ITEM_SCHEMA.properties,
    sentence_structure: SENTENCE_STRUCTURE_SCHEMA,
    grammar_points: { type: 'array', items: GRAMMAR_POINT_SCHEMA },
    vocabulary: { type: 'array', items: VOCABULARY_ITEM_SCHEMA },
    common_mistakes: { type: 'array', items: { type: 'string' } },
    similar_expressions: { type: 'array', items: SIMILAR_EXPRESSION_SCHEMA },
    example_sentences: { type: 'array', items: EXAMPLE_SENTENCE_SCHEMA },
  },
  required: [
    ...LIGHT_RESULT_ITEM_SCHEMA.required,
    'sentence_structure',
    'grammar_points',
    'vocabulary',
    'common_mistakes',
    'similar_expressions',
    'example_sentences',
  ],
  additionalProperties: false,
};

function buildResponseSchema(itemSchema: unknown) {
  return {
    type: 'object',
    properties: { results: { type: 'array', items: itemSchema } },
    required: ['results'],
    additionalProperties: false,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return jsonResponse({ error: 'missing_authorization' }, 401);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: authError } = await authClient.auth.getUser(jwt);
  if (authError || !userData?.user) {
    return jsonResponse({ error: 'invalid_or_expired_token' }, 401);
  }
  const userId = userData.user.id;

  let sentences: string[] | undefined;
  let detailed = false;
  try {
    const body = await req.json();
    sentences = body?.sentences;
    detailed = body?.detailed === true;
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return jsonResponse({ error: 'missing_sentences' }, 400);
  }
  if (sentences.length > MAX_CHUNK_SIZE) {
    return jsonResponse({ error: 'chunk_too_large', max: MAX_CHUNK_SIZE }, 400);
  }
  // The detailed schema's per-item output is large enough that letting it
  // apply to more than one sentence would risk the exact truncation bug
  // this function was already hit by -- so it's a hard, not a soft, limit.
  if (detailed && sentences.length > MAX_DETAILED_SENTENCES) {
    return jsonResponse({ error: 'detailed_mode_single_sentence_only', max: MAX_DETAILED_SENTENCES }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Global kill switch.
  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) {
    console.warn('[analyze-batch] rejected: ai_disabled');
    return jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503);
  }

  // 2. Concurrency lock: at most 1 in-flight AI request per user.
  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) {
    console.warn('[analyze-batch] rejected: concurrent_request_limit', lockError.message);
    return jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429);
  }

  try {
    // 3. Per-user rate limits + today's usage (chunk counts as `sentences.length` analyses).
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) {
      console.error('[analyze-batch] rate_limits_not_provisioned for user', userId);
      return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);
    }

    for (const sentence of sentences) {
      if (sentence.length > limits.max_input_chars) {
        return jsonResponse({ error: 'input_too_long' }, 400);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await admin
      .from('ai_daily_usage')
      .select('*')
      .eq('user_id', userId)
      .eq('usage_date', today)
      .maybeSingle();

    const analysesToday = usage?.expression_analyses_count ?? 0;
    if (analysesToday + sentences.length > limits.daily_expression_analyses) {
      await logUsage(admin, userId, 'rejected', 'daily_limit_exceeded');
      console.warn('[analyze-batch] rejected: daily_limit_exceeded', { analysesToday, requested: sentences.length, limit: limits.daily_expression_analyses });
      return jsonResponse({ error: 'daily_limit_exceeded', remaining: Math.max(0, limits.daily_expression_analyses - analysesToday) }, 429);
    }

    // 4. Budget caps.
    const dailyCost = usage?.estimated_cost_usd ?? 0;
    if (dailyCost >= config.daily_budget_usd) {
      await logUsage(admin, userId, 'rejected', 'daily_budget_exceeded');
      console.warn('[analyze-batch] rejected: daily_budget_exceeded', { dailyCost, limit: config.daily_budget_usd });
      return jsonResponse({ error: 'daily_budget_exceeded' }, 429);
    }
    const month = `${today.slice(0, 7)}-01`;
    const { data: monthlyUsage } = await admin
      .from('ai_monthly_usage')
      .select('estimated_cost_usd')
      .eq('user_id', userId)
      .eq('usage_month', month)
      .maybeSingle();
    if ((monthlyUsage?.estimated_cost_usd ?? 0) >= config.monthly_budget_usd) {
      await logUsage(admin, userId, 'rejected', 'monthly_budget_exceeded');
      console.warn('[analyze-batch] rejected: monthly_budget_exceeded');
      return jsonResponse({ error: 'monthly_budget_exceeded' }, 429);
    }

    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];

    const { id: usageLogId } = await logUsage(admin, userId, 'reserved', null, model);

    if (!OPENAI_API_KEY) {
      console.error('[analyze-batch] OPENAI_API_KEY is not set (check: supabase secrets list)');
      await admin.from('ai_usage_log').update({ status: 'failed', rejection_reason: 'openai_key_not_configured' }).eq('id', usageLogId);
      return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    }

    let results: (BatchItemResult | DetailedBatchItemResult)[];
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const maxOutputTokens = computeMaxOutputTokens(sentences.length, limits.max_output_tokens, detailed);
      const completion = await callOpenAI(sentences, model, maxOutputTokens, detailed);
      results = completion.results;
      inputTokens = completion.inputTokens;
      outputTokens = completion.outputTokens;

      // "AI 응답이 잘못되면 해당 배치만 재시도": a count mismatch means the
      // model didn't return one result per input sentence -- treat the
      // whole chunk as failed rather than guessing at a partial mapping.
      if (results.length !== sentences.length) {
        throw new Error(`result_count_mismatch: expected ${sentences.length}, got ${results.length}`);
      }
    } catch (err) {
      const message = String(err);
      // Distinguish "output got cut off / wasn't valid JSON" from other
      // OpenAI failures with its own error code, so the client
      // (aiBatchClient.ts) can retry ONLY this case (by splitting the
      // chunk smaller) and never retry e.g. a 401/403/429.
      const isTruncation = message.includes('output_truncated');
      console.error('[analyze-batch] openai_call_failed', err instanceof Error ? err.stack ?? err.message : err);
      await admin
        .from('ai_usage_log')
        .update({ status: 'failed', rejection_reason: message })
        .eq('id', usageLogId);
      return jsonResponse({ error: isTruncation ? 'output_truncated' : 'openai_call_failed', message }, 502);
    }

    const estimatedCost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

    await admin
      .from('ai_usage_log')
      .update({ status: 'completed', input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost_usd: estimatedCost })
      .eq('id', usageLogId);

    await admin.rpc('increment_ai_usage', {
      p_user_id: userId,
      p_cost_usd: estimatedCost,
      p_expression_analyses: sentences.length,
    });

    return jsonResponse({ ok: true, results });
  } catch (err) {
    // Without this catch, ANY unexpected throw here (not just the
    // anticipated OpenAI-call failure above) propagated uncaught out of
    // the handler after `finally` ran -- Deno's edge runtime then returns
    // a generic 502 "EDGE_FUNCTION_ERROR" with no application log at all,
    // which is exactly what was observed in production. Logging here (no
    // request body, no API key -- just the error itself) makes the next
    // occurrence visible in Dashboard -> Edge Functions -> Logs instead of
    // an opaque 502.
    console.error('[analyze-batch] unhandled error', err instanceof Error ? err.stack ?? err.message : err);
    return jsonResponse({ error: 'internal_error', message: '예상치 못한 서버 오류가 발생했습니다.' }, 500);
  } finally {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
  }
});

async function logUsage(
  admin: ReturnType<typeof createClient>,
  userId: string,
  status: 'reserved' | 'rejected',
  rejectionReason: string | null,
  model = 'gpt-4o-mini'
) {
  const { data } = await admin
    .from('ai_usage_log')
    .insert({ user_id: userId, feature: 'expression_analysis', model, status, rejection_reason: rejectionReason })
    .select('id')
    .single();
  return { id: data?.id };
}

const LIGHT_SYSTEM_PROMPT_HEADER = `You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) who just pasted a batch of French sentences/expressions they encountered.

For EACH input sentence, in the SAME ORDER, produce one result object with:
- expression_fr: echo the original sentence back EXACTLY as given (this is used to match results back to inputs -- do not fix typos here).
- corrected_fr: if the sentence has a real grammar/spelling error, the corrected version; otherwise null.
- meaning_ko: a natural Korean translation.
- grammar_note: ONE Korean paragraph covering the grammar structure AND any key vocabulary/prepositions worth noting, plus a brief note on naturalness/errors if corrected_fr is not null.
- example_fr: one additional natural French example sentence reusing the same key expression (different from the input sentence).
- example_translation_ko: Korean translation of that example.
- cefr_level: your best estimate, one of A1/A2/B1/B2/C1/C2.
- tags: 1-3 short topic/grammar tags in Korean or French (e.g. "접속법", "일상 회화").
- key_phrase: the single core phrase/pattern from this sentence most worth memorizing (e.g. "penser à", "il faut que + subjonctif").`;

const DETAILED_SYSTEM_PROMPT_EXTRA = `
You are also asked for a deeper B1~B2 breakdown of this ONE sentence, for all the fields above PLUS:
- sentence_structure: if the sentence has a main clause + subordinate clause (e.g. "il faut que + subjonctif"), fill in main_clause, conjunction, subordinate_clause, core_structure, infinitive (the subordinate verb's infinitive, or "" if none), conjugated_form (the actual conjugated form used, or "" if none), mood_explanation (Korean: why this mood -- subjunctive/indicative/etc. -- is used here), mood_contrast (Korean: how the meaning would differ with the other mood, or "" if not applicable), overall_meaning (Korean: a natural reading of the whole sentence). If the input is just a word/short phrase with no clause structure, set sentence_structure to null -- do not force a breakdown that doesn't apply.
- grammar_points: 1 to 3 objects {pattern, meaning, example}, most useful first -- the actual grammar patterns present (tense/mood, structures like "avoir beau + infinitif", pronouns, negation). meaning is a Korean explanation anchored in THIS sentence, not a generic textbook definition. example is a different French sentence using the same pattern.
- vocabulary: 0 to 6 objects for words/short expressions genuinely worth explaining (skip articles and trivial words -- "모든 관사와 쉬운 단어를 기계적으로 설명하지 않기"). Each: {word, part_of_speech, meaning_ko, infinitive (verb's dictionary form, or null), tense_or_conjugation (or null), gender_agreement (or null), preposition (preposition this word pairs with, or null), common_mistake (a mistake Korean learners often make with this word, or null)}.
- common_mistakes: 0 to 3 short Korean strings about mistakes Korean learners commonly make with THIS sentence/expression as a whole (separate from per-word ones already in vocabulary). Empty array if none stand out.
- similar_expressions: 0 to 3 objects {a, b, difference} ONLY for expressions genuinely easy to confuse with something in this sentence (e.g. "penser à" / "penser de", "depuis" / "pendant"). difference is a short Korean explanation. Return an empty array rather than inventing a comparison that isn't real.
- example_sentences: EXACTLY 2 objects {fr, ko} -- new natural French example sentences reusing this sentence's key expression/structure, set in everyday Quebec life, at B1 level. Do not invent facts about a specific person; keep them generic.`;

async function callOpenAI(
  sentences: string[],
  model: string,
  maxOutputTokens: number,
  detailed: boolean
): Promise<{ results: (BatchItemResult | DetailedBatchItemResult)[]; inputTokens: number; outputTokens: number }> {
  const systemPrompt =
    LIGHT_SYSTEM_PROMPT_HEADER +
    (detailed ? DETAILED_SYSTEM_PROMPT_EXTRA : '') +
    `\n\nReturn exactly ${sentences.length} result objects, one per input sentence, in input order. Never invent sentences that weren't given.`;

  const schema = detailed ? DETAILED_RESULT_ITEM_SCHEMA : LIGHT_RESULT_ITEM_SCHEMA;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'batch_analysis', strict: true, schema: buildResponseSchema(schema) },
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(sentences) },
      ],
    }),
  });

  if (!response.ok) {
    // Include OpenAI's own error body (never the API key -- that's only
    // ever sent in the outgoing request header, never present in any
    // response) so "model not found" / invalid schema / quota errors are
    // distinguishable from each other instead of just a bare status code.
    const errorBody = await response.text().catch(() => '');
    throw new Error(`openai_http_${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const payload = await response.json();
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('openai_empty_response');

  // This is the actual fix for the production "Unterminated string in
  // JSON" error: when the model hits max_tokens mid-generation, OpenAI
  // sets finish_reason: 'length' and `content` is a truncated, invalid
  // JSON string. Checking this BEFORE JSON.parse turns that into a clear,
  // specific error instead of a raw SyntaxError -- and gives the caller
  // (src/features/ai-batch/aiBatchClient.ts) a code it can recognize to
  // retry with a smaller chunk, rather than treating it like any other
  // failure. Never log `content` itself (it's the user's pasted text).
  if (choice?.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error(`output_truncated: finish_reason=${choice.finish_reason}, length=${content.length}`);
  }

  let parsed: { results: (BatchItemResult | DetailedBatchItemResult)[] };
  try {
    parsed = JSON.parse(content) as { results: (BatchItemResult | DetailedBatchItemResult)[] };
  } catch {
    // Belt-and-suspenders: even if finish_reason somehow read 'stop', a
    // response that still isn't valid JSON gets the same "try a smaller
    // chunk" treatment instead of crashing the whole request uncaught.
    throw new Error(`output_truncated: invalid_json, length=${content.length}`);
  }

  return {
    results: parsed.results ?? [],
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}
