// Supabase Edge Function: analyze-expression
//
// Called (fire-and-forget) right after a user saves a raw expression. Looks
// up the expression, calls OpenAI to fill in lemma/meaning/definition/example/
// grammar/CEFR level, and writes the result back. Never blocks the save
// flow on the client side -- if this fails, the raw expression the user
// typed is already safely in Postgres.
//
// Security requirements this function must uphold (see
// docs/Claude_프랑스어앱_개발보안지시서.docx):
//   1. The caller's JWT is verified server-side; user_id is taken ONLY from
//      that verified token, never trusted from the request body.
//   2. Global AI kill switch (ai_system_config.ai_enabled) is checked first.
//   3. At most 1 concurrent AI request per user (ai_active_requests).
//   4. Per-user daily rate limits (ai_rate_limits / ai_daily_usage).
//   5. Daily + monthly budget caps (ai_system_config, ai_daily_usage/ai_monthly_usage).
//   6. Input length, output token count, and model are all capped server-side.
//   7. The OpenAI key lives only in this function's environment (Supabase
//      secret), never in the request/response bodies or in any DB row.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

// Approximate OpenAI pricing (USD per 1M tokens). VERIFY against
// https://openai.com/api/pricing before relying on this for real budget
// enforcement -- prices change over time and this is only as accurate as
// the last time someone updated it here.
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

interface AnalysisResult {
  lemma: string;
  meaning_ko: string;
  definition_fr: string;
  example_fr: string;
  example_translation_ko: string;
  grammar_note: string;
  part_of_speech: string;
  related_expressions: { expression_fr: string; meaning_ko: string }[];
  cefr_level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return jsonResponse({ error: 'missing_authorization' }, 401);

  // Verify the JWT against Supabase Auth -- this is the ONLY source of truth
  // for who the caller is. We never read a user_id from the request body.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: authError } = await authClient.auth.getUser(jwt);
  if (authError || !userData?.user) {
    return jsonResponse({ error: 'invalid_or_expired_token' }, 401);
  }
  const userId = userData.user.id;

  let expressionId: string | undefined;
  try {
    const body = await req.json();
    expressionId = body?.expressionId;
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }
  if (!expressionId) return jsonResponse({ error: 'missing_expressionId' }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Global kill switch.
  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) {
    return jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503);
  }

  // 2. Concurrency lock: at most 1 in-flight AI request per user.
  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) {
    return jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429);
  }

  try {
    // 3. Per-user rate limits + today's usage.
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);

    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await admin
      .from('ai_daily_usage')
      .select('*')
      .eq('user_id', userId)
      .eq('usage_date', today)
      .maybeSingle();

    const analysesToday = usage?.expression_analyses_count ?? 0;
    if (analysesToday >= limits.daily_expression_analyses) {
      await logUsage(admin, userId, 'rejected', 'daily_limit_exceeded');
      return jsonResponse({ error: 'daily_limit_exceeded' }, 429);
    }

    // 4. Budget caps.
    const dailyCost = usage?.estimated_cost_usd ?? 0;
    if (dailyCost >= config.daily_budget_usd) {
      await logUsage(admin, userId, 'rejected', 'daily_budget_exceeded');
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
      return jsonResponse({ error: 'monthly_budget_exceeded' }, 429);
    }

    // 5. Load + validate the expression (ownership check is defense-in-depth;
    // the service role bypasses RLS, so we enforce user_id = userId here).
    const { data: expression, error: exprError } = await admin
      .from('expressions')
      .select('id, user_id, expression_fr')
      .eq('id', expressionId)
      .eq('user_id', userId)
      .single();
    if (exprError || !expression) {
      return jsonResponse({ error: 'expression_not_found' }, 404);
    }
    if (expression.expression_fr.length > limits.max_input_chars) {
      return jsonResponse({ error: 'input_too_long' }, 400);
    }

    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];

    const { id: usageLogId } = await logUsage(admin, userId, 'reserved', null, model);

    if (!OPENAI_API_KEY) {
      await admin.from('ai_usage_log').update({ status: 'failed', rejection_reason: 'openai_key_not_configured' }).eq('id', usageLogId);
      await admin.from('expressions').update({ ai_analysis_status: 'failed' }).eq('id', expressionId);
      return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    }

    let analysis: AnalysisResult;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const completion = await callOpenAI(expression.expression_fr, model, limits.max_output_tokens);
      analysis = completion.analysis;
      inputTokens = completion.inputTokens;
      outputTokens = completion.outputTokens;
    } catch (err) {
      await admin
        .from('ai_usage_log')
        .update({ status: 'failed', rejection_reason: String(err) })
        .eq('id', usageLogId);
      await admin.from('expressions').update({ ai_analysis_status: 'failed' }).eq('id', expressionId);
      return jsonResponse({ error: 'openai_call_failed' }, 502);
    }

    const estimatedCost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

    await admin
      .from('expressions')
      .update({
        lemma: analysis.lemma,
        meaning_ko: analysis.meaning_ko,
        definition_fr: analysis.definition_fr,
        part_of_speech: analysis.part_of_speech,
        grammar_note: analysis.grammar_note,
        related_expressions: analysis.related_expressions,
        cefr_level: analysis.cefr_level,
        ai_analysis_status: 'completed',
      })
      .eq('id', expressionId);

    await admin.from('expression_examples').insert({
      expression_id: expressionId,
      sentence_fr: analysis.example_fr,
      translation_ko: analysis.example_translation_ko,
      is_user_created: false,
    });

    await admin
      .from('ai_usage_log')
      .update({ status: 'completed', input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost_usd: estimatedCost })
      .eq('id', usageLogId);

    await admin.rpc('increment_ai_usage', {
      p_user_id: userId,
      p_cost_usd: estimatedCost,
      p_expression_analyses: 1,
    });

    return jsonResponse({ ok: true, analysis });
  } finally {
    // Always release the concurrency lock, even on an early return/throw above.
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

async function callOpenAI(
  expressionFr: string,
  model: string,
  maxOutputTokens: number
): Promise<{ analysis: AnalysisResult; inputTokens: number; outputTokens: number }> {
  const systemPrompt = `You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) who just captured a French expression.
Given a French word or expression, respond with ONLY a JSON object with these exact fields:
lemma (base/dictionary form in French), meaning_ko (Korean meaning), definition_fr (simple French definition a B1 learner can understand), example_fr (one natural French example sentence using the expression), example_translation_ko (Korean translation of that example), grammar_note (brief grammar note in Korean, e.g. conjugation pattern or preposition usage), part_of_speech (in French, e.g. "verbe", "nom", "expression idiomatique"), related_expressions (array of up to 3 objects {expression_fr, meaning_ko} of related/synonym expressions), cefr_level (one of A1, A2, B1, B2, C1, C2 estimating the expression's difficulty).`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: expressionFr },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`openai_http_${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('openai_empty_response');

  const analysis = JSON.parse(content) as AnalysisResult;
  return {
    analysis,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}
