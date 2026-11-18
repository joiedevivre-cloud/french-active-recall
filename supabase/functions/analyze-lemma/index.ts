// Supabase Edge Function: analyze-lemma
//
// Two actions building ONE personal dictionary feature:
// - 'classify' (default, backward compatible): groups ONE saved sentence
//   under its lemma + the exact grammatical construction it demonstrates.
//   Cached per expression in expression_analysis.
// - 'seed_dictionary': generates a lemma's main dictionary usages up
//   front (no specific sentence). mode 'preview' = generate + strong-model
//   self-check, nothing saved; mode 'apply' = save the senses the user
//   picked (code rules re-run). See _shared/prompts/seedDictionary.ts.
// Usage patterns are always STORED in standard notation (qqn/qqch/inf.,
// _shared/patternNotation.ts) so the same construction is never two usages.
// Kept in one file (shared security/budget scaffold, same tables) rather
// than two -- these are two steps of one feature, unlike analyze-batch vs
// this function, which are genuinely different AI capabilities.
//
// Completely separate from analyze-batch's detailed_analysis (different
// tables, never reads/writes expressions.* besides reading expression_fr).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import {
  ANALYZE_RESPONSE_SCHEMA,
  SENTENCE_ANALYSIS_PROMPT_KEY,
  buildUserPrompt,
  type AnalyzeAiResult,
  type ExistingLemmaContext,
} from '../_shared/prompts/analyze.ts';
import {
  shouldSkipAnalysis,
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldPreserveField,
  shouldRetryAfterSchemaFailure,
} from '../_shared/lemmaMatching.ts';
// The sentence-analysis prompt is DB-managed (/admin/prompts, migration
// 0018); classify always uses the ACTIVE version via the shared loader.
import { loadActivePrompt, type LoadedPrompt } from '../_shared/promptLoader.ts';
import { pickAllowedModel } from '../_shared/promptTemplate.ts';
import { callOpenAIJsonSchema } from '../_shared/openaiJson.ts';
import { canonicalizePattern } from '../_shared/patternNotation.ts';
import {
  SEED_GENERATE_RESPONSE_SCHEMA,
  SEED_GENERATE_SYSTEM_PROMPT,
  SEED_MAX_CANDIDATES,
  SEED_VERIFY_RESPONSE_SCHEMA,
  SEED_VERIFY_SYSTEM_PROMPT,
  buildSeedGenerateUserPrompt,
  buildSeedVerifyUserPrompt,
  mergeExamples,
  prepareSeedSenses,
  sanitizeSense,
  type SeedSense,
  type SeedVerdict,
} from '../_shared/prompts/seedDictionary.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const MAX_EXPRESSION_IDS = 20;
const MAX_SCHEMA_RETRY_ATTEMPTS = 2; // 1 initial try + 1 retry
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};
// seed_dictionary self-check runs on a stronger model than generation
// (gpt-4o-mini produced English calques). Override with the secret
// SEED_VERIFY_MODEL; unknown models are billed at the gpt-4.1 rate.
const SEED_VERIFY_MODEL = Deno.env.get('SEED_VERIFY_MODEL') ?? 'gpt-4.1';

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

    const prompt = await loadActivePrompt(admin, SENTENCE_ANALYSIS_PROMPT_KEY);
    // The version may name a model, but the user's allowed_models list keeps the final say.
    const model = pickAllowedModel(prompt.model, limits.allowed_models);
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
          const completion = await callClassifyOpenAI(sentence, existingLemmaContext, model, prompt);
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
        const applied = await applyClassifyResult(admin, userId, expressionId, ai, existingByExprId.get(expressionId) ?? null, model, prompt);
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
  const mode = body.mode === 'apply' ? 'apply' : 'preview';

  const { data: lemma } = await admin.from('lemmas').select('id, lemma').eq('id', lemmaId).eq('user_id', userId).maybeSingle();
  if (!lemma) return jsonResponse({ error: 'lemma_not_found' }, 404);

  const loadExisting = async () => {
    const { data } = await admin
      .from('lemma_usages')
      .select('id, label, pattern, meaning_ko, grammar_explanation_ko, ai_example_sentences, user_edited_fields')
      .eq('lemma_id', lemmaId);
    return data ?? [];
  };

  // ---- apply: save what the user picked from the preview. No AI call; the
  // code rules run again (the body is client input), then merge/insert.
  if (mode === 'apply') {
    const raw = Array.isArray(body.senses) ? body.senses.slice(0, SEED_MAX_CANDIDATES) : [];
    const pairs = raw
      .map((r) => ({ sense: sanitizeSense(r), mergeInto: typeof (r as { mergeInto?: unknown })?.mergeInto === 'string' ? ((r as { mergeInto: string }).mergeInto) : null }))
      .filter((p): p is { sense: SeedSense; mergeInto: string | null } => p.sense !== null);
    if (pairs.length === 0) return jsonResponse({ error: 'no_senses' }, 400);
    const existing = await loadExisting();
    // mergeInto is honoured only when it is a similar (qqn/qqch) usage of THIS lemma -- checked inside prepareSeedSenses
    const { accepted, rejected } = prepareSeedSenses(pairs.map((p) => p.sense), null, existing, { chosenMerges: pairs.map((p) => p.mergeInto) });

    const { count: existingCount } = await admin.from('lemma_usages').select('id', { count: 'exact', head: true }).eq('lemma_id', lemmaId);
    let sortOrder = existingCount ?? 0;
    const usageIds: string[] = [];
    for (const sense of accepted) {
      if (sense.mergeTargetId) {
        // Same construction as an existing usage: only ADD examples and fill
        // empty fields. Label / meaning the learner already has stay as-is.
        const target = existing.find((u) => u.id === sense.mergeTargetId)!;
        const update: Record<string, unknown> = {};
        if (!shouldPreserveField(target.user_edited_fields, 'ai_example_sentences')) {
          update.ai_example_sentences = mergeExamples(target.ai_example_sentences, sense.examples);
        }
        if (!target.meaning_ko && !shouldPreserveField(target.user_edited_fields, 'meaning_ko')) update.meaning_ko = sense.meaning_ko;
        if (!target.grammar_explanation_ko && !shouldPreserveField(target.user_edited_fields, 'grammar_explanation_ko')) {
          update.grammar_explanation_ko = sense.grammar_explanation_ko;
        }
        if (Object.keys(update).length > 0) await admin.from('lemma_usages').update(update).eq('id', sense.mergeTargetId);
        usageIds.push(sense.mergeTargetId);
        continue;
      }
      // Plain insert, not upsert: a label collision with a DIFFERENT
      // construction must fail loudly, never overwrite the other usage.
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
          // no dedicated columns for these: kept in the explanation the card already shows
          grammar_explanation_ko: [sense.grammar_explanation_ko, sense.contrast_ko, sense.mood_note_ko].filter(Boolean).join(' '),
          common_mistakes_ko: sense.common_mistakes_ko,
          ai_example_sentences: sense.examples,
          source: 'dictionary',
          sort_order: sortOrder++,
        })
        .select('id')
        .single();
      if (insertError) {
        console.warn('[analyze-lemma] seed_dictionary insert skipped', insertError.message);
        rejected.push({ label: sense.label, pattern: sense.pattern, reason_ko: '같은 이름의 쓰임이 이미 있어 저장하지 못했어요.' });
      } else if (inserted) {
        usageIds.push(inserted.id);
      }
    }
    return jsonResponse({ ok: true, usageIds, rejected });
  }

  // ---- preview: generate -> strong-model self-check -> code rules. Nothing is saved.
  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) return jsonResponse({ error: 'ai_disabled', message: 'AI 기능이 현재 일시 중지되어 있습니다.' }, 503);

  await admin.rpc('sweep_stale_ai_locks', { p_max_age_seconds: 120 });
  const { error: lockError } = await admin.from('ai_active_requests').insert({ user_id: userId });
  if (lockError) return jsonResponse({ error: 'concurrent_request_limit', message: '이전 요청이 아직 처리중입니다.' }, 429);

  try {
    const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
    if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);
    const budgetCheck = await checkDailyBudgetAndUsage(admin, userId, config, limits, 1);
    if (budgetCheck.error) return budgetCheck.error;
    if (!OPENAI_API_KEY) return jsonResponse({ error: 'openai_key_not_configured' }, 500);

    const model = limits.allowed_models?.[0] ?? 'gpt-4o-mini';
    let totalCost = 0;
    const account = async (m: string, inputTokens: number, outputTokens: number) => {
      const pricing = MODEL_PRICING_PER_1M_TOKENS[m] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4.1'];
      const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
      totalCost += cost;
      await settleUsageLog(admin, userId, m, inputTokens, outputTokens, cost);
    };

    let generated: SeedSense[] = [];
    let lastError: string | null = null;
    for (let attempt = 0; attempt < MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
      try {
        const payload = await callOpenAIJsonSchema({
          apiKey: OPENAI_API_KEY,
          systemPrompt: SEED_GENERATE_SYSTEM_PROMPT,
          userPrompt: buildSeedGenerateUserPrompt(lemma.lemma),
          model,
          schema: SEED_GENERATE_RESPONSE_SCHEMA,
          schemaName: 'seed_dictionary',
          maxOutputTokens: 5000,
        });
        await account(model, payload.inputTokens, payload.outputTokens);
        generated = ((payload.parsed as { senses: unknown[] }).senses ?? []).map(sanitizeSense).filter((s): s is SeedSense => s !== null);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error('[analyze-lemma] seed generate failed', lastError);
        if (!shouldRetryAfterSchemaFailure(attempt, MAX_SCHEMA_RETRY_ATTEMPTS - 1)) break;
      }
    }
    if (lastError) return jsonResponse({ error: 'openai_call_failed', message: lastError }, 502);

    // Self-check with the stronger model. Fail closed: no verdicts -> nothing offered.
    let verdicts: SeedVerdict[];
    let missing: SeedSense[] = [];
    try {
      const payload = await callOpenAIJsonSchema({
        apiKey: OPENAI_API_KEY,
        systemPrompt: SEED_VERIFY_SYSTEM_PROMPT,
        userPrompt: buildSeedVerifyUserPrompt(lemma.lemma, generated),
        model: SEED_VERIFY_MODEL,
        schema: SEED_VERIFY_RESPONSE_SCHEMA,
        schemaName: 'seed_verify',
        maxOutputTokens: 6000,
        temperature: 0,
      });
      await account(SEED_VERIFY_MODEL, payload.inputTokens, payload.outputTokens);
      const parsed = payload.parsed as { verdicts: SeedVerdict[]; missing: unknown[] };
      verdicts = parsed.verdicts;
      missing = (parsed.missing ?? []).map(sanitizeSense).filter((s): s is SeedSense => s !== null);
    } catch (err) {
      console.error('[analyze-lemma] seed verify failed', err instanceof Error ? err.message : err);
      return jsonResponse({ error: 'verification_failed', message: '검증 단계가 실패해서 아무것도 추가하지 않았어요.' }, 502);
    }

    const { accepted, rejected } = prepareSeedSenses([...generated, ...missing], verdicts, await loadExisting(), { missingFromIndex: generated.length });
    await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: totalCost, p_expression_analyses: 1 });
    return jsonResponse({ ok: true, senses: accepted, rejected, models: { generate: model, verify: SEED_VERIFY_MODEL } });
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
  model: string,
  prompt: LoadedPrompt
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
            pattern: canonicalizePattern(ai.usage.pattern),
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
      if (!shouldPreserveField(existingUsage?.user_edited_fields, 'pattern')) update.pattern = canonicalizePattern(ai.usage.pattern);
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
      prompt_version: prompt.versionLabel, // legacy text column, kept
      prompt_version_id: prompt.versionId, // null only when the code fallback was used
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

async function callClassifyOpenAI(
  sentence: string,
  existingLemmas: ExistingLemmaContext[],
  model: string,
  prompt: LoadedPrompt
): Promise<{ result: AnalyzeAiResult; inputTokens: number; outputTokens: number }> {
  const payload = await callOpenAIJsonSchema({
    apiKey: OPENAI_API_KEY!,
    systemPrompt: prompt.systemPrompt,
    userPrompt: buildUserPrompt(sentence, existingLemmas),
    model,
    schema: ANALYZE_RESPONSE_SCHEMA,
    schemaName: 'lemma_analysis',
    maxOutputTokens: 1200,
    temperature: prompt.temperature,
  });
  return { result: payload.parsed as AnalyzeAiResult, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens };
}
