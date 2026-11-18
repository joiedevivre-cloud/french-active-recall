// Supabase Edge Function: analyze-lemma
//
// Groups expressions by their key word (lemma) + usage (e.g. "mettre" ->
// 놓다/두다 vs 옷을 입다 vs 기기를 켜다 vs se mettre à...), and generates
// pronunciation (IPA/Korean/liaison) + 1-3 grammar points, cached in
// expression_analysis so it only ever runs once per expression unless
// force:true is passed. Completely separate feature from analyze-batch's
// detailed_analysis (different tables, never reads/writes expressions.*).
//
// Deliberately a COPY of analyze-batch's security/budget scaffold
// (JWT verification -> kill switch -> 1-concurrent-request lock -> daily
// rate limit/budget -> usage log) rather than a shared refactor, so this new
// function carries zero regression risk for analyze-batch, which was only
// just fixed and verified for a real production 502/truncation bug. A
// shared helper can be extracted later once this has also seen real traffic
// -- noted in README.md.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { ANALYZE_SYSTEM_PROMPT, ANALYZE_RESPONSE_SCHEMA, PROMPT_VERSION, buildUserPrompt, type AnalyzeAiResult, type ExistingLemmaContext } from '../_shared/prompts/analyze.ts';
import {
  shouldSkipAnalysis,
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldRetryAfterSchemaFailure,
} from '../_shared/lemmaMatching.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const MAX_EXPRESSION_IDS = 20;
const MAX_SCHEMA_RETRY_ATTEMPTS = 2; // 1 initial try + 1 retry, per spec ("1회만 재시도")
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
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

  let expressionIds: string[] | undefined;
  let force = false;
  try {
    const body = await req.json();
    expressionIds = body?.expressionIds;
    force = body?.force === true;
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }
  if (!Array.isArray(expressionIds) || expressionIds.length === 0) {
    return jsonResponse({ error: 'missing_expression_ids' }, 400);
  }
  if (expressionIds.length > MAX_EXPRESSION_IDS) {
    return jsonResponse({ error: 'too_many_expression_ids', max: MAX_EXPRESSION_IDS }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) {
    console.warn('[analyze-lemma] rejected: ai_disabled');
    return jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503);
  }

  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) {
    console.warn('[analyze-lemma] rejected: concurrent_request_limit', lockError.message);
    return jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429);
  }

  try {
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) {
      console.error('[analyze-lemma] rate_limits_not_provisioned for user', userId);
      return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);
    }

    const { data: expressions, error: exprError } = await admin
      .from('expressions')
      .select('id, expression_fr')
      .in('id', expressionIds)
      .eq('user_id', userId);
    if (exprError || !expressions) {
      console.error('[analyze-lemma] failed to load expressions', exprError?.message);
      return jsonResponse({ error: 'expressions_lookup_failed' }, 500);
    }
    const exprById = new Map(expressions.map((e) => [e.id, e.expression_fr as string]));

    // Cache check: skip entirely (no AI call) for ids that already have an
    // expression_analysis row, unless force:true.
    const { data: existingAnalyses } = await admin
      .from('expression_analysis')
      .select('expression_id, lemma_id, usage_id, usage_user_assigned')
      .in('expression_id', expressionIds);
    const existingByExprId = new Map((existingAnalyses ?? []).map((r) => [r.expression_id, r]));

    const toAnalyze = expressionIds.filter((id) => exprById.has(id) && !shouldSkipAnalysis(existingByExprId.has(id), force));
    const skipped = expressionIds.filter((id) => !toAnalyze.includes(id));

    if (toAnalyze.length === 0) {
      return jsonResponse({ ok: true, results: skipped.map((id) => ({ expression_id: id, status: 'cached' })) });
    }

    for (const id of toAnalyze) {
      const text = exprById.get(id)!;
      if (text.length > limits.max_input_chars) {
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
    if (analysesToday + toAnalyze.length > limits.daily_expression_analyses) {
      await logUsage(admin, userId, 'rejected', 'daily_limit_exceeded');
      console.warn('[analyze-lemma] rejected: daily_limit_exceeded', { analysesToday, requested: toAnalyze.length, limit: limits.daily_expression_analyses });
      return jsonResponse({ error: 'daily_limit_exceeded', remaining: Math.max(0, limits.daily_expression_analyses - analysesToday) }, 429);
    }

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

    if (!OPENAI_API_KEY) {
      console.error('[analyze-lemma] OPENAI_API_KEY is not set (check: supabase secrets list)');
      return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    }

    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];

    // All of this user's existing lemmas+usages, used as prompt context so
    // the model reuses an existing usage instead of inventing a near-dup.
    const { data: existingLemmaRows } = await admin.from('lemmas').select('id, lemma, part_of_speech').eq('user_id', userId);
    const { data: existingUsageRows } = await admin
      .from('lemma_usages')
      .select('id, lemma_id, label, meaning_en, pattern')
      .eq('user_id', userId);

    const results: Record<string, unknown>[] = skipped.map((id) => ({ expression_id: id, status: 'cached' }));
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const expressionId of toAnalyze) {
      const sentence = exprById.get(expressionId)!;
      const existingLemmaContext: ExistingLemmaContext[] = (existingLemmaRows ?? []).map((l) => ({
        id: l.id,
        lemma: l.lemma,
        part_of_speech: l.part_of_speech,
        usages: (existingUsageRows ?? [])
          .filter((u) => u.lemma_id === l.id)
          .map((u) => ({ id: u.id, label: u.label, meaning_en: u.meaning_en, pattern: u.pattern })),
      }));

      let ai: AnalyzeAiResult | null = null;
      let lastError: string | null = null;
      for (let attempt = 0; attempt < MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
        try {
          const completion = await callOpenAI(sentence, existingLemmaContext, model);
          ai = completion.result;
          totalInputTokens += completion.inputTokens;
          totalOutputTokens += completion.outputTokens;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          console.error('[analyze-lemma] attempt failed', expressionId, lastError);
          if (!shouldRetryAfterSchemaFailure(attempt, MAX_SCHEMA_RETRY_ATTEMPTS - 1)) break;
        }
      }

      if (!ai) {
        results.push({ expression_id: expressionId, status: 'failed', error: lastError ?? 'unknown_error' });
        continue;
      }

      try {
        const applied = await applyAiResult(admin, userId, expressionId, ai, existingByExprId.get(expressionId) ?? null, model);
        results.push({ expression_id: expressionId, status: 'success', ...applied });
      } catch (err) {
        console.error('[analyze-lemma] db_write_failed', expressionId, err instanceof Error ? err.message : err);
        results.push({ expression_id: expressionId, status: 'failed', error: 'db_write_failed' });
      }
    }

    const estimatedCost = (totalInputTokens / 1_000_000) * pricing.input + (totalOutputTokens / 1_000_000) * pricing.output;
    await logUsage(admin, userId, 'reserved', null, model).then(({ id }) =>
      id
        ? admin
            .from('ai_usage_log')
            .update({ status: 'completed', input_tokens: totalInputTokens, output_tokens: totalOutputTokens, estimated_cost_usd: estimatedCost })
            .eq('id', id)
        : null
    );
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: estimatedCost, p_expression_analyses: toAnalyze.length });

    return jsonResponse({ ok: true, results });
  } catch (err) {
    console.error('[analyze-lemma] unhandled error', err instanceof Error ? err.stack ?? err.message : err);
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
    .insert({ user_id: userId, feature: 'lemma_analysis', model, status, rejection_reason: rejectionReason })
    .select('id')
    .single();
  return { id: data?.id };
}

async function applyAiResult(
  admin: ReturnType<typeof createClient>,
  userId: string,
  expressionId: string,
  ai: AnalyzeAiResult,
  existingAnalysis: { lemma_id: string; usage_id: string; usage_user_assigned: boolean } | null,
  model: string
) {
  const { data: lemma, error: lemmaError } = await admin
    .from('lemmas')
    .upsert(
      {
        user_id: userId,
        lemma: ai.lemma,
        part_of_speech: ai.part_of_speech,
        pronunciation_ipa: ai.pronunciation_ipa,
        pronunciation_ko: ai.pronunciation_ko,
        pronunciation_note: ai.pronunciation_note,
        grammar_notes: ai.grammar_notes,
      },
      { onConflict: 'user_id,lemma' }
    )
    .select('id')
    .single();
  if (lemmaError || !lemma) throw new Error(`lemma_upsert_failed: ${lemmaError?.message}`);

  const preserveAssignment = shouldPreserveUserAssignedUsage(existingAnalysis);
  let lemmaId = lemma.id as string;
  let usageId: string;

  if (preserveAssignment && existingAnalysis) {
    lemmaId = existingAnalysis.lemma_id;
    usageId = existingAnalysis.usage_id;
  } else {
    const { data: usagesForLemma } = await admin.from('lemma_usages').select('id, label, label_user_edited').eq('lemma_id', lemmaId);
    const resolvedId = resolveExistingUsageId(ai.usage.existing_usage_id, usagesForLemma ?? []);

    if (shouldCreateNewUsage(resolvedId)) {
      const { count } = await admin.from('lemma_usages').select('id', { count: 'exact', head: true }).eq('lemma_id', lemmaId);
      const { data: newUsage, error: usageError } = await admin
        .from('lemma_usages')
        .upsert(
          { user_id: userId, lemma_id: lemmaId, label: ai.usage.label, meaning_en: ai.usage.meaning_en, pattern: ai.usage.pattern, sort_order: count ?? 0 },
          { onConflict: 'lemma_id,label' }
        )
        .select('id')
        .single();
      if (usageError || !newUsage) throw new Error(`usage_upsert_failed: ${usageError?.message}`);
      usageId = newUsage.id;
    } else {
      usageId = resolvedId!;
      const existingUsage = (usagesForLemma ?? []).find((u) => u.id === usageId) ?? null;
      if (!shouldPreserveUserEditedLabel(existingUsage)) {
        await admin.from('lemma_usages').update({ meaning_en: ai.usage.meaning_en, pattern: ai.usage.pattern }).eq('id', usageId);
      }
    }
  }

  const { error: analysisError } = await admin.from('expression_analysis').upsert(
    {
      expression_id: expressionId,
      user_id: userId,
      lemma_id: lemmaId,
      usage_id: usageId,
      usage_user_assigned: preserveAssignment,
      pronunciation_ko: ai.sentence_pronunciation.pronunciation_ko,
      pronunciation_liaison: ai.sentence_pronunciation.pronunciation_liaison,
      pronunciation_note: ai.sentence_pronunciation.pronunciation_note,
      grammar_points: ai.grammar_points,
      level: ai.level,
      model,
      prompt_version: PROMPT_VERSION,
    },
    { onConflict: 'expression_id' }
  );
  if (analysisError) throw new Error(`expression_analysis_upsert_failed: ${analysisError.message}`);

  return { lemma_id: lemmaId, usage_id: usageId };
}

async function callOpenAI(
  sentence: string,
  existingLemmas: ExistingLemmaContext[],
  model: string
): Promise<{ result: AnalyzeAiResult; inputTokens: number; outputTokens: number }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      response_format: { type: 'json_schema', json_schema: { name: 'lemma_analysis', strict: true, schema: ANALYZE_RESPONSE_SCHEMA } },
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(sentence, existingLemmas) },
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

  let parsed: AnalyzeAiResult;
  try {
    parsed = JSON.parse(content) as AnalyzeAiResult;
  } catch {
    throw new Error(`invalid_json: length=${content.length}`);
  }

  return {
    result: parsed,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}
