// Supabase Edge Function: analyze-lemma
//
// Two actions building ONE personal dictionary feature:
// - 'classify' (default, backward compatible): groups ONE saved sentence
//   under its lemma + the exact grammatical construction it demonstrates.
//   Cached per expression in expression_analysis.
// - 'seed_dictionary': generates a lemma's main dictionary senses up
//   front (no specific sentence), merged into the same lemma_usages pool.
// Kept in one file (shared security/budget scaffold, same tables) rather
// than two -- these are two steps of one feature, unlike analyze-batch vs
// this function, which are genuinely different AI capabilities.
//
// Completely separate from analyze-batch's detailed_analysis (different
// tables, never reads/writes expressions.* besides reading expression_fr).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import {
  ANALYZE_SYSTEM_PROMPT,
  ANALYZE_RESPONSE_SCHEMA,
  SEED_DICTIONARY_SYSTEM_PROMPT,
  SEED_DICTIONARY_RESPONSE_SCHEMA,
  PROMPT_VERSION,
  buildUserPrompt,
  buildSeedDictionaryUserPrompt,
  type AnalyzeAiResult,
  type ExistingLemmaContext,
  type SeedDictionarySense,
} from '../_shared/prompts/analyze.ts';
import {
  shouldSkipAnalysis,
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldPreserveField,
  findMergeTargetUsageId,
  shouldRetryAfterSchemaFailure,
} from '../_shared/lemmaMatching.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const MAX_EXPRESSION_IDS = 20;
const MAX_SCHEMA_RETRY_ATTEMPTS = 2; // 1 initial try + 1 retry
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const action = body.action === 'seed_dictionary' ? 'seed_dictionary' : 'classify';

  try {
    if (action === 'seed_dictionary') return await handleSeedDictionary(admin, userId, body);
    return await handleClassify(admin, userId, body);
  } catch (err) {
    console.error('[analyze-lemma] unhandled error', err instanceof Error ? err.stack ?? err.message : err);
    return jsonResponse({ error: 'internal_error', message: '예상치 못한 서버 오류가 발생했습니다.' }, 500);
  }
});

async function handleClassify(admin: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const expressionIds = body.expressionIds as string[] | undefined;
  const force = body.force === true;

  if (!Array.isArray(expressionIds) || expressionIds.length === 0) {
    return jsonResponse({ error: 'missing_expression_ids' }, 400);
  }
  if (expressionIds.length > MAX_EXPRESSION_IDS) {
    return jsonResponse({ error: 'too_many_expression_ids', max: MAX_EXPRESSION_IDS }, 400);
  }

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
      if (text.length > limits.max_input_chars) return jsonResponse({ error: 'input_too_long' }, 400);
    }

    const budgetCheck = await checkDailyBudgetAndUsage(admin, userId, config, limits, toAnalyze.length);
    if (budgetCheck.error) return budgetCheck.error;

    if (!OPENAI_API_KEY) {
      console.error('[analyze-lemma] OPENAI_API_KEY is not set (check: supabase secrets list)');
      return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    }

    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];

    const { data: existingLemmaRows } = await admin.from('lemmas').select('id, lemma, part_of_speech').eq('user_id', userId);
    const { data: existingUsageRows } = await admin
      .from('lemma_usages')
      .select('id, lemma_id, label, meaning_ko, pattern')
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
          .map((u) => ({ id: u.id, label: u.label, meaning_ko: u.meaning_ko, pattern: u.pattern })),
      }));

      let ai: AnalyzeAiResult | null = null;
      let lastError: string | null = null;
      for (let attempt = 0; attempt < MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
        try {
          const completion = await callClassifyOpenAI(sentence, existingLemmaContext, model);
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
        const applied = await applyClassifyResult(admin, userId, expressionId, ai, existingByExprId.get(expressionId) ?? null, model);
        results.push({ expression_id: expressionId, status: 'success', ...applied });
      } catch (err) {
        console.error('[analyze-lemma] db_write_failed', expressionId, err instanceof Error ? err.message : err);
        results.push({ expression_id: expressionId, status: 'failed', error: 'db_write_failed' });
      }
    }

    const estimatedCost = (totalInputTokens / 1_000_000) * pricing.input + (totalOutputTokens / 1_000_000) * pricing.output;
    await settleUsageLog(admin, userId, model, totalInputTokens, totalOutputTokens, estimatedCost);
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: estimatedCost, p_expression_analyses: toAnalyze.length });

    return jsonResponse({ ok: true, results });
  } finally {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
  }
}

async function handleSeedDictionary(admin: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const lemmaId = body.lemmaId as string | undefined;
  if (!lemmaId) return jsonResponse({ error: 'missing_lemma_id' }, 400);

  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) return jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503);

  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) return jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429);

  try {
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);

    const { data: lemma } = await admin.from('lemmas').select('id, lemma').eq('id', lemmaId).eq('user_id', userId).maybeSingle();
    if (!lemma) return jsonResponse({ error: 'lemma_not_found' }, 404);

    const budgetCheck = await checkDailyBudgetAndUsage(admin, userId, config, limits, 1);
    if (budgetCheck.error) return budgetCheck.error;

    if (!OPENAI_API_KEY) return jsonResponse({ error: 'openai_key_not_configured' }, 500);
    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    const pricing = MODEL_PRICING_PER_1M_TOKENS[model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];

    let senses: SeedDictionarySense[] = [];
    let lastError: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
      try {
        const completion = await callSeedDictionaryOpenAI(lemma.lemma, model);
        senses = completion.result;
        inputTokens = completion.inputTokens;
        outputTokens = completion.outputTokens;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error('[analyze-lemma] seed_dictionary attempt failed', lemma.lemma, lastError);
        if (!shouldRetryAfterSchemaFailure(attempt, MAX_SCHEMA_RETRY_ATTEMPTS - 1)) break;
      }
    }
    if (senses.length === 0 && lastError) {
      return jsonResponse({ error: 'openai_call_failed', message: lastError }, 502);
    }

    const { data: existingUsages } = await admin
      .from('lemma_usages')
      .select('id, pattern, user_edited_fields, label_user_edited')
      .eq('lemma_id', lemmaId);

    const { count: existingCount } = await admin.from('lemma_usages').select('id', { count: 'exact', head: true }).eq('lemma_id', lemmaId);
    let sortOrder = existingCount ?? 0;
    const usageIds: string[] = [];

    for (const sense of senses) {
      const mergeTargetId = findMergeTargetUsageId(sense.pattern, (existingUsages ?? []).map((u) => ({ id: u.id, pattern: u.pattern })));

      if (mergeTargetId) {
        const target = (existingUsages ?? []).find((u) => u.id === mergeTargetId)!;
        const update: Record<string, unknown> = {};
        if (!shouldPreserveUserEditedLabel(target)) update.label = sense.label;
        if (!shouldPreserveField(target.user_edited_fields, 'meaning_ko')) update.meaning_ko = sense.meaning_ko;
        if (!shouldPreserveField(target.user_edited_fields, 'required_complement')) update.required_complement = sense.required_complement;
        if (!shouldPreserveField(target.user_edited_fields, 'mood_requirement')) update.mood_requirement = sense.mood_requirement;
        if (!shouldPreserveField(target.user_edited_fields, 'grammar_explanation_ko')) update.grammar_explanation_ko = sense.grammar_explanation_ko;
        if (!shouldPreserveField(target.user_edited_fields, 'common_mistakes_ko')) update.common_mistakes_ko = sense.common_mistakes_ko;
        if (!shouldPreserveField(target.user_edited_fields, 'ai_example_sentences')) {
          update.ai_example_sentences = [{ fr: sense.example_fr, ko: sense.example_ko }];
        }
        if (Object.keys(update).length > 0) {
          await admin.from('lemma_usages').update(update).eq('id', mergeTargetId);
        }
        usageIds.push(mergeTargetId);
      } else {
        // Plain insert, not upsert: the (lemma_id, label) unique constraint
        // must never silently merge a DIFFERENT pattern into an existing
        // row just because the AI happened to pick the same short label --
        // that is exactly the "wrongly merged into an unrelated usage" bug
        // this migration fixes. A genuine label collision fails loudly
        // (logged, sense skipped) instead of overwriting the wrong row.
        const { data: inserted, error: insertError } = await admin
          .from('lemma_usages')
          .insert({
            user_id: userId,
            lemma_id: lemmaId,
            label: sense.label,
            meaning_ko: sense.meaning_ko,
            pattern: sense.pattern,
            required_complement: sense.required_complement,
            mood_requirement: sense.mood_requirement === 'none' ? null : sense.mood_requirement,
            grammar_explanation_ko: sense.grammar_explanation_ko,
            common_mistakes_ko: sense.common_mistakes_ko,
            ai_example_sentences: [{ fr: sense.example_fr, ko: sense.example_ko }],
            source: 'dictionary',
            sort_order: sortOrder++,
          })
          .select('id')
          .single();
        if (insertError) {
          console.warn('[analyze-lemma] seed_dictionary sense insert skipped', sense.label, insertError.message);
        } else if (inserted) {
          usageIds.push(inserted.id);
        }
      }
    }

    const estimatedCost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
    await settleUsageLog(admin, userId, model, inputTokens, outputTokens, estimatedCost);
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: estimatedCost, p_expression_analyses: 1 });

    return jsonResponse({ ok: true, senseCount: senses.length, usageIds });
  } finally {
    await admin.from('ai_active_requests').delete().eq('user_id', userId);
  }
}

async function checkDailyBudgetAndUsage(
  admin: ReturnType<typeof createClient>,
  userId: string,
  config: { daily_budget_usd: number; monthly_budget_usd: number },
  limits: { daily_expression_analyses: number },
  requestedCount: number
): Promise<{ error: Response | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from('ai_daily_usage').select('*').eq('user_id', userId).eq('usage_date', today).maybeSingle();

  const analysesToday = usage?.expression_analyses_count ?? 0;
  if (analysesToday + requestedCount > limits.daily_expression_analyses) {
    await logUsage(admin, userId, 'rejected', 'daily_limit_exceeded');
    return { error: jsonResponse({ error: 'daily_limit_exceeded', remaining: Math.max(0, limits.daily_expression_analyses - analysesToday) }, 429) };
  }

  const dailyCost = usage?.estimated_cost_usd ?? 0;
  if (dailyCost >= config.daily_budget_usd) {
    await logUsage(admin, userId, 'rejected', 'daily_budget_exceeded');
    return { error: jsonResponse({ error: 'daily_budget_exceeded' }, 429) };
  }
  const month = `${today.slice(0, 7)}-01`;
  const { data: monthlyUsage } = await admin.from('ai_monthly_usage').select('estimated_cost_usd').eq('user_id', userId).eq('usage_month', month).maybeSingle();
  if ((monthlyUsage?.estimated_cost_usd ?? 0) >= config.monthly_budget_usd) {
    await logUsage(admin, userId, 'rejected', 'monthly_budget_exceeded');
    return { error: jsonResponse({ error: 'monthly_budget_exceeded' }, 429) };
  }
  return { error: null };
}

async function logUsage(admin: ReturnType<typeof createClient>, userId: string, status: 'reserved' | 'rejected', rejectionReason: string | null, model = 'gpt-4o-mini') {
  const { data } = await admin.from('ai_usage_log').insert({ user_id: userId, feature: 'lemma_analysis', model, status, rejection_reason: rejectionReason }).select('id').single();
  return { id: data?.id };
}

async function settleUsageLog(admin: ReturnType<typeof createClient>, userId: string, model: string, inputTokens: number, outputTokens: number, cost: number) {
  const { id } = await logUsage(admin, userId, 'reserved', null, model);
  if (id) {
    await admin.from('ai_usage_log').update({ status: 'completed', input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost_usd: cost }).eq('id', id);
  }
}

async function applyClassifyResult(
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
  let isNewUsageLink = false;

  if (preserveAssignment && existingAnalysis) {
    lemmaId = existingAnalysis.lemma_id;
    usageId = existingAnalysis.usage_id;
  } else {
    const { data: usagesForLemma } = await admin
      .from('lemma_usages')
      .select('id, label, pattern, label_user_edited, user_edited_fields')
      .eq('lemma_id', lemmaId);
    const resolvedId = resolveExistingUsageId(ai.usage.existing_usage_id, ai.usage.pattern, usagesForLemma ?? []);

    if (shouldCreateNewUsage(resolvedId)) {
      const { count } = await admin.from('lemma_usages').select('id', { count: 'exact', head: true }).eq('lemma_id', lemmaId);
      const { data: newUsage, error: usageError } = await admin
        .from('lemma_usages')
        .upsert(
          {
            user_id: userId,
            lemma_id: lemmaId,
            label: ai.usage.label,
            meaning_ko: ai.usage.meaning_ko,
            pattern: ai.usage.pattern,
            source: 'learned',
            sort_order: count ?? 0,
          },
          { onConflict: 'lemma_id,label' }
        )
        .select('id')
        .single();
      if (usageError || !newUsage) throw new Error(`usage_upsert_failed: ${usageError?.message}`);
      usageId = newUsage.id;
      isNewUsageLink = true;
    } else {
      usageId = resolvedId!;
      const existingUsage = (usagesForLemma ?? []).find((u) => u.id === usageId) ?? null;
      const update: Record<string, unknown> = {};
      if (!shouldPreserveUserEditedLabel(existingUsage)) update.label = ai.usage.label;
      if (!shouldPreserveField(existingUsage?.user_edited_fields, 'meaning_ko')) update.meaning_ko = ai.usage.meaning_ko;
      if (!shouldPreserveField(existingUsage?.user_edited_fields, 'pattern')) update.pattern = ai.usage.pattern;
      if (Object.keys(update).length > 0) {
        await admin.from('lemma_usages').update(update).eq('id', usageId);
      }
    }
  }

  const { data: existingUsageLink } = await admin.from('expression_analysis').select('expression_id').eq('usage_id', usageId).limit(1).maybeSingle();
  if (!existingUsageLink) isNewUsageLink = true;

  const { error: analysisError } = await admin.from('expression_analysis').upsert(
    {
      expression_id: expressionId,
      user_id: userId,
      lemma_id: lemmaId,
      usage_id: usageId,
      usage_user_assigned: preserveAssignment,
      pronunciation_ipa: ai.sentence_pronunciation.pronunciation_ipa,
      pronunciation_note: ai.sentence_pronunciation.pronunciation_note,
      grammar_points: ai.grammar_points,
      level: ai.level,
      model,
      prompt_version: PROMPT_VERSION,
    },
    { onConflict: 'expression_id' }
  );
  if (analysisError) throw new Error(`expression_analysis_upsert_failed: ${analysisError.message}`);

  // First real sentence for this usage -- enter it into the FSRS queue at
  // the usage level too (mirrors enqueueForReview's idempotent upsert for
  // expressions, same "due_at=now()" semantics, just a different target).
  if (isNewUsageLink) {
    await admin.from('review_states').upsert({ user_id: userId, lemma_usage_id: usageId }, { onConflict: 'user_id,lemma_usage_id', ignoreDuplicates: true });
  }

  return { lemma_id: lemmaId, usage_id: usageId };
}

async function callClassifyOpenAI(sentence: string, existingLemmas: ExistingLemmaContext[], model: string): Promise<{ result: AnalyzeAiResult; inputTokens: number; outputTokens: number }> {
  const payload = await callOpenAIJsonSchema(ANALYZE_SYSTEM_PROMPT, buildUserPrompt(sentence, existingLemmas), model, ANALYZE_RESPONSE_SCHEMA, 'lemma_analysis', 1200);
  return { result: payload.parsed as AnalyzeAiResult, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens };
}

async function callSeedDictionaryOpenAI(lemma: string, model: string): Promise<{ result: SeedDictionarySense[]; inputTokens: number; outputTokens: number }> {
  const payload = await callOpenAIJsonSchema(
    SEED_DICTIONARY_SYSTEM_PROMPT,
    buildSeedDictionaryUserPrompt(lemma),
    model,
    SEED_DICTIONARY_RESPONSE_SCHEMA,
    'seed_dictionary',
    2500
  );
  return { result: (payload.parsed as { senses: SeedDictionarySense[] }).senses, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens };
}

async function callOpenAIJsonSchema(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  schema: unknown,
  schemaName: string,
  maxOutputTokens: number
): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number }> {
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
