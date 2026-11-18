// Supabase Edge Function: writing-practice
//
// Two actions of ONE feature ("make a problem from a saved expression,
// then correct the learner's written answer"), sharing 100% of the
// security/budget scaffold -- unlike analyze-batch vs analyze-lemma
// (genuinely different AI capabilities), generate/correct are two steps
// of the same flow, so one file with an action dispatch is clearer than
// duplicating the scaffold into two files for no isolation benefit.
//
// Same security requirements as analyze-batch/analyze-lemma: server-side
// JWT verification, global kill switch, 1 concurrent request per user,
// per-user daily rate limits + budget caps, OpenAI key never leaves this
// function's environment. Deliberately NOT sharing business logic with
// those two functions beyond _shared/cors.ts, so a bug here can never
// regress either of them (see supabase/functions/_shared/writingPractice.ts
// for the pure logic this function uses, dual-imported by Vitest).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { pickCachedExercise, shouldSkipGeneration, sanitizeGrammarTags, suggestRatingFromCorrection } from '../_shared/writingPractice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const PROMPT_VERSION = 'writing-practice-v1';
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};
const GENERATE_MAX_OUTPUT_TOKENS = 700;
const CORRECT_MAX_OUTPUT_TOKENS = 1200;

const GENERATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    prompt_ko: { type: 'string' },
    prompt_fr_pattern: { type: ['string', 'null'] },
    scenario_context: {
      type: ['object', 'null'],
      properties: { situation: { type: 'string' }, role_ko: { type: 'string' }, constraints_ko: { type: 'string' } },
      required: ['situation', 'role_ko', 'constraints_ko'],
      additionalProperties: false,
    },
  },
  required: ['prompt_ko', 'prompt_fr_pattern', 'scenario_context'],
  additionalProperties: false,
};

const CORRECTION_ITEM_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, note_ko: { type: 'string' } },
  required: ['text', 'note_ko'],
  additionalProperties: false,
};

const CORRECT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    meaning_ok: { type: 'boolean' },
    grammar_errors: { type: 'array', items: CORRECTION_ITEM_SCHEMA },
    vocab_preposition_errors: { type: 'array', items: CORRECTION_ITEM_SCHEMA },
    tense_conjugation_errors: { type: 'array', items: CORRECTION_ITEM_SCHEMA },
    naturalness_notes_ko: { type: ['string', 'null'] },
    target_grammar_used: { type: ['boolean', 'null'] },
    corrected_fr: { type: ['string', 'null'] },
    explanation_ko: { type: 'string' },
    grammar_error_tags: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'meaning_ok', 'grammar_errors', 'vocab_preposition_errors', 'tense_conjugation_errors',
    'naturalness_notes_ko', 'target_grammar_used', 'corrected_fr', 'explanation_ko', 'grammar_error_tags',
  ],
  additionalProperties: false,
};

const MODE_GUIDANCE: Record<string, string> = {
  transform: `Mode: SENTENCE TRANSFORMATION. Base the exercise on the given expression's grammar pattern, but change the subject/tense/object/situation so it is NOT a copy of the original. prompt_ko: a Korean sentence/situation the learner must translate into French using that same pattern. prompt_fr_pattern: the canonical pattern (e.g. "il faut que + subjonctif"). scenario_context: null.`,
  korean_prompt: `Mode: KOREAN -> FRENCH FREE WRITING. prompt_ko: a natural Korean situation/sentence (not a literal translation target, a situation to express) that would naturally use the given expression's key grammar. prompt_fr_pattern: the target pattern to watch for. scenario_context: null.`,
  situational: `Mode: REALISTIC QUEBEC-LIFE SITUATIONAL WRITING (e.g. asking a landlord for a repair, booking a doctor's appointment, inquiring about a job). Never invent specific personal facts about the learner -- keep the scenario generic. prompt_ko: the Korean task description. prompt_fr_pattern: null. scenario_context: {situation, role_ko (who the learner is addressing), constraints_ko (what must be included)}.`,
  speaking: `Mode: SPOKEN PRACTICE (the learner will answer out loud, speech-to-text). Generate the same shape as KOREAN_PROMPT -- a natural Korean situation to express in French. prompt_fr_pattern: the target pattern. scenario_context: null.`,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return jsonResponse({ error: 'missing_authorization' }, 401);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: authError } = await authClient.auth.getUser(jwt);
  if (authError || !userData?.user) return jsonResponse({ error: 'invalid_or_expired_token' }, 401);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (body.action === 'generate') return await handleGenerate(admin, userId, body);
    if (body.action === 'correct') return await handleCorrect(admin, userId, body);
    return jsonResponse({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('[writing-practice] unhandled error', err instanceof Error ? err.stack ?? err.message : err);
    return jsonResponse({ error: 'internal_error', message: '예상치 못한 서버 오류가 발생했습니다.' }, 500);
  }
});

async function handleGenerate(admin: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const expressionId = body.expressionId as string | undefined;
  const mode = body.mode as string | undefined;
  const grammarTags = Array.isArray(body.grammarTags) ? (body.grammarTags as string[]) : [];
  const forceNew = body.forceNew === true;
  // "이 문법으로 문장 만들기" (expression detail screen): practice ONE specific
  // construction of the expression (e.g. its 2nd grammar point), not just
  // the expression's main pattern. Cached separately per construction.
  const targetPattern =
    typeof body.targetPattern === 'string' && body.targetPattern.trim() ? body.targetPattern.trim().slice(0, 200) : null;

  if (!expressionId || !mode || !MODE_GUIDANCE[mode]) return jsonResponse({ error: 'missing_or_invalid_fields' }, 400);

  const { data: expr } = await admin.from('expressions').select('id, expression_fr').eq('id', expressionId).eq('user_id', userId).maybeSingle();
  if (!expr) return jsonResponse({ error: 'expression_not_found' }, 404);

  let existingQuery = admin
    .from('writing_exercises')
    .select('id, times_used, prompt_ko, prompt_fr_pattern, scenario_context')
    .eq('user_id', userId)
    .eq('expression_id', expressionId)
    .eq('mode', mode);
  if (targetPattern) existingQuery = existingQuery.eq('prompt_fr_pattern', targetPattern);
  const { data: existing } = await existingQuery;

  const cached = pickCachedExercise((existing ?? []).map((r) => ({ id: r.id, timesUsed: r.times_used })), forceNew);

  if (shouldSkipGeneration(cached)) {
    const row = (existing ?? []).find((r) => r.id === cached!.id)!;
    await admin.from('writing_exercises').update({ times_used: row.times_used + 1 }).eq('id', row.id);
    return jsonResponse({
      ok: true,
      cached: true,
      exercise: { id: row.id, mode, promptKo: row.prompt_ko, promptFrPattern: row.prompt_fr_pattern, scenarioContext: row.scenario_context, grammarTags },
    });
  }

  const gate = await checkBudgetAndLock(admin, userId);
  if (gate.error) return gate.error;

  try {
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);

    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await admin.from('ai_daily_usage').select('writing_generations_count').eq('user_id', userId).eq('usage_date', today).maybeSingle();
    if ((usage?.writing_generations_count ?? 0) >= limits.daily_writing_generations) {
      return jsonResponse({ error: 'daily_limit_exceeded' }, 429);
    }

    if (!OPENAI_API_KEY) return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';

    const systemPrompt = `You generate French-learning writing exercises for a Korean-speaking learner (B1~B2, living in Montreal). The learner already saved this expression: "${expr.expression_fr}". ${MODE_GUIDANCE[mode]}${
      targetPattern
        ? ` TARGET CONSTRUCTION (required): the situation must make the learner naturally use exactly "${targetPattern}" -- not the expression's other grammar. Set prompt_fr_pattern to exactly "${targetPattern}". Use a NEW situation (different subject/context from the saved expression).`
        : ''
    } Write prompt_fr_pattern with standard French grammar terms (e.g. "bien que + proposition au subjonctif", "se mettre à + infinitif"). Never fabricate facts about a specific real person.`;
    const completion = await callOpenAI(systemPrompt, 'Generate one exercise now.', model, GENERATE_RESULT_SCHEMA, 'exercise_generation', GENERATE_MAX_OUTPUT_TOKENS);

    const contentHash = await sha256Hex(JSON.stringify(completion.result));
    const { data: inserted, error: insertError } = await admin
      .from('writing_exercises')
      .upsert(
        {
          user_id: userId,
          expression_id: expressionId,
          mode,
          grammar_tags: grammarTags,
          prompt_ko: completion.result.prompt_ko,
          prompt_fr_pattern: targetPattern ?? completion.result.prompt_fr_pattern,
          scenario_context: completion.result.scenario_context,
          model,
          prompt_version: PROMPT_VERSION,
          content_hash: contentHash,
          times_used: 1,
        },
        { onConflict: 'user_id,expression_id,mode,content_hash' }
      )
      .select('id')
      .single();
    if (insertError || !inserted) throw new Error(`writing_exercise_insert_failed: ${insertError?.message}`);

    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];
    const cost = (completion.inputTokens / 1_000_000) * pricing.input + (completion.outputTokens / 1_000_000) * pricing.output;
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: cost, p_writing_generations: 1 });

    return jsonResponse({
      ok: true,
      cached: false,
      exercise: {
        id: inserted.id,
        mode,
        promptKo: completion.result.prompt_ko,
        promptFrPattern: targetPattern ?? completion.result.prompt_fr_pattern,
        scenarioContext: completion.result.scenario_context,
        grammarTags,
      },
    });
  } catch (err) {
    const message = String(err);
    const isTruncation = message.includes('output_truncated');
    console.error('[writing-practice] generate_failed', err instanceof Error ? err.stack ?? err.message : err);
    return jsonResponse({ error: isTruncation ? 'output_truncated' : 'openai_call_failed', message }, 502);
  } finally {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
  }
}

async function handleCorrect(admin: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const expressionId = body.expressionId as string | undefined;
  const mode = body.mode as string | undefined;
  const userAnswerFr = body.userAnswerFr as string | undefined;
  const grammarTags = Array.isArray(body.grammarTags) ? (body.grammarTags as string[]) : [];
  const exerciseId = (body.exerciseId as string | undefined) ?? null;
  const targetGrammar = (body.targetGrammar as string | undefined) ?? null;

  if (!expressionId || !mode || !userAnswerFr) return jsonResponse({ error: 'missing_or_invalid_fields' }, 400);

  const gate = await checkBudgetAndLock(admin, userId);
  if (gate.error) return gate.error;

  try {
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);
    if (userAnswerFr.length > limits.max_input_chars) return jsonResponse({ error: 'input_too_long' }, 400);

    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await admin.from('ai_daily_usage').select('writing_corrections_count').eq('user_id', userId).eq('usage_date', today).maybeSingle();
    if ((usage?.writing_corrections_count ?? 0) >= limits.daily_writing_corrections) {
      return jsonResponse({ error: 'daily_limit_exceeded' }, 429);
    }

    if (!OPENAI_API_KEY) return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';

    const systemPrompt = `You correct a Korean-speaking French learner's (B1~B2) written answer to a practice exercise. Evaluate ONLY what is given -- never fabricate facts about the learner. Multiple different phrasings can be equally correct; NEVER grade by exact string match against any single "expected" sentence. If the answer already conveys the meaning correctly and naturally, set corrected_fr to null -- do not force an unnecessary correction. explanation_ko is a short Korean explanation of the most important issue (or why it's already good); name grammar concepts with standard French terms (subjonctif, infinitif, groupe nominal (GN), proposition subordonnée, accord du participe passé...), explain in Korean. grammar_error_tags: short snake_case-ish tags for grammar points that need more practice (e.g. "subjonctif", "penser_a_de"), empty array if none.${targetGrammar ? ` Target grammar for this exercise: ${targetGrammar} -- set target_grammar_used accordingly.` : ' There is no specific target grammar for this exercise -- set target_grammar_used to null.'}`;
    const userPrompt = JSON.stringify({ learner_answer_fr: userAnswerFr });

    const completion = await callOpenAI(systemPrompt, userPrompt, model, CORRECT_RESULT_SCHEMA, 'writing_correction', CORRECT_MAX_OUTPUT_TOKENS);
    const result = completion.result;

    const suggestedRating = suggestRatingFromCorrection({
      meaningOk: result.meaning_ok,
      hasGrammarErrors: result.grammar_errors.length > 0,
      hasVocabOrPrepositionErrors: result.vocab_preposition_errors.length > 0,
      hasTenseOrConjugationErrors: result.tense_conjugation_errors.length > 0,
    });

    const cleanTags = sanitizeGrammarTags(result.grammar_error_tags);
    const allTags = [...new Set([...grammarTags, ...cleanTags])];
    // Not using the target construction at all counts as a miss for it,
    // even if the sentence is otherwise fine -- that is what puts a weak
    // construction back in front of the learner (grammar_skills feeds
    // buildTodayQueue's weak-tag priority).
    const attemptCorrect = result.meaning_ok && result.grammar_errors.length === 0 && result.target_grammar_used !== false;
    for (const tag of allTags) {
      await admin.rpc('record_grammar_attempt', { p_tag: tag, p_correct: attemptCorrect });
    }

    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];
    const cost = (completion.inputTokens / 1_000_000) * pricing.input + (completion.outputTokens / 1_000_000) * pricing.output;
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: cost, p_writing_corrections: 1 });

    return jsonResponse({ ok: true, correction: result, aiSuggestedRating: suggestedRating, exerciseId });
  } catch (err) {
    const message = String(err);
    const isTruncation = message.includes('output_truncated');
    console.error('[writing-practice] correct_failed', err instanceof Error ? err.stack ?? err.message : err);
    return jsonResponse({ error: isTruncation ? 'output_truncated' : 'openai_call_failed', message }, 502);
  } finally {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
  }
}

/** Kill switch + 1-concurrent-request lock, shared by both actions' AI-calling paths. */
async function checkBudgetAndLock(admin: ReturnType<typeof createClient>, userId: string): Promise<{ error: Response | null }> {
  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) {
    console.warn('[writing-practice] rejected: ai_disabled');
    return { error: jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503) };
  }

  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) {
    console.warn('[writing-practice] rejected: concurrent_request_limit', lockError.message);
    return { error: jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429) };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from('ai_daily_usage').select('estimated_cost_usd').eq('user_id', userId).eq('usage_date', today).maybeSingle();
  if ((usage?.estimated_cost_usd ?? 0) >= config.daily_budget_usd) {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
    return { error: jsonResponse({ error: 'daily_budget_exceeded' }, 429) };
  }
  const month = `${today.slice(0, 7)}-01`;
  const { data: monthlyUsage } = await admin.from('ai_monthly_usage').select('estimated_cost_usd').eq('user_id', userId).eq('usage_month', month).maybeSingle();
  if ((monthlyUsage?.estimated_cost_usd ?? 0) >= config.monthly_budget_usd) {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
    return { error: jsonResponse({ error: 'monthly_budget_exceeded' }, 429) };
  }

  return { error: null };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  schema: unknown,
  schemaName: string,
  maxOutputTokens: number
): Promise<{ result: any; inputTokens: number; outputTokens: number }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`openai_http_${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const payload = await response.json();
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('openai_empty_response');
  if (choice?.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error(`output_truncated: finish_reason=${choice.finish_reason}, length=${content.length}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`output_truncated: invalid_json, length=${content.length}`);
  }

  return {
    result: parsed,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}
