// Supabase Edge Function: admin-prompts
//
// Admin-only prompt management (README "프롬프트 관리", migration 0018):
// list versions, save/delete drafts, restore (= copy into a new draft),
// preview a version on test cases or a custom sentence, activate.
//
// Security:
// - JWT verified server-side; admin = app_metadata.role === 'admin' on the
//   verified user (cannot be set by the user). Anyone else gets 403 before
//   any table is touched. The frontend menu is only a convenience.
// - prompt_* tables have RLS with no policies; only this function's
//   service-role client reads/writes them.
// - Preview NEVER writes learning data (lemmas, lemma_usages,
//   expression_analysis, review_states...). It reads the admin's own
//   lemmas/usages (read-only) to give the model the same context as
//   analyze-lemma, and stores results in prompt_test_runs only.
// - Preview calls respect the kill switch and budget caps and are logged as
//   ai_usage_log.feature = 'prompt_admin'. Logs never include the sentence,
//   the prompt text or keys.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { isAdminUser } from '../_shared/adminAuth.ts';
import { ANALYZE_RESPONSE_SCHEMA, buildUserPrompt, type ExistingLemmaContext } from '../_shared/prompts/analyze.ts';
import { buildLoadedPrompt, DEFAULT_INSTRUCTIONS, PROMPT_REGISTRY, type PromptVersionRow } from '../_shared/promptLoader.ts';
import {
  AVAILABLE_VARIABLES,
  DEFAULT_PROMPT_SETTINGS,
  checkTemplate,
  isValidTemperature,
  validateSettings,
} from '../_shared/promptTemplate.ts';
import { callOpenAIJsonSchema } from '../_shared/openaiJson.ts';
import { validateSentenceAnalysis, type TestCaseExpectations } from '../_shared/sentenceAnalysisValidation.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const MAX_INSTRUCTIONS_CHARS = 20000;
const MAX_PREVIEWS_PER_DAY = 300;
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

type Admin = ReturnType<typeof createClient>;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return jsonResponse({ error: 'missing_authorization' }, 401);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: authError } = await authClient.auth.getUser(jwt);
  if (authError || !userData?.user) return jsonResponse({ error: 'invalid_or_expired_token' }, 401);
  if (!isAdminUser(userData.user)) {
    console.warn('[admin-prompts] rejected: not_admin');
    return jsonResponse({ error: 'forbidden', message: '관리자 전용 기능입니다.' }, 403);
  }
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json_body' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const promptKey = typeof body.promptKey === 'string' ? body.promptKey : 'sentence-analysis';
  if (!PROMPT_REGISTRY[promptKey]) return jsonResponse({ error: 'unknown_prompt_key' }, 400);

  try {
    switch (body.action) {
      case 'overview':
        return await handleOverview(admin, userId, promptKey);
      case 'runs':
        return await handleRuns(admin, body);
      case 'save_draft':
        return await handleSaveDraft(admin, userId, promptKey, body);
      case 'delete_draft':
        return await handleDeleteDraft(admin, body);
      case 'restore':
        return await handleRestore(admin, userId, body);
      case 'preview':
        return await handlePreview(admin, userId, promptKey, body);
      case 'activate':
        return await handleActivate(admin, body);
      default:
        return jsonResponse({ error: 'unknown_action' }, 400);
    }
  } catch (err) {
    console.error('[admin-prompts] unhandled error', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
    return jsonResponse({ error: 'internal_error', message: '예상치 못한 서버 오류가 발생했습니다.' }, 500);
  }
});

async function handleOverview(admin: Admin, userId: string, promptKey: string) {
  const [{ data: versions, error: vErr }, { data: cases }, { data: limits }] = await Promise.all([
    admin
      .from('prompt_versions')
      .select('id, version_no, status, instructions, settings, model, temperature, change_note, based_on_version_id, created_at, updated_at, activated_at')
      .eq('prompt_key', promptKey)
      .order('version_no', { ascending: false }),
    admin.from('prompt_test_cases').select('id, expression_fr, meaning_ko, note, expectations, sort_order').eq('prompt_key', promptKey).order('sort_order'),
    admin.from('ai_rate_limits').select('allowed_models').eq('user_id', userId).maybeSingle(),
  ]);
  if (vErr) return jsonResponse({ error: 'db_error', message: vErr.message }, 500);

  return jsonResponse({
    ok: true,
    promptKey,
    versions: versions ?? [],
    testCases: cases ?? [],
    outputContract: PROMPT_REGISTRY[promptKey].outputContract,
    defaultInstructions: DEFAULT_INSTRUCTIONS[promptKey],
    availableVariables: AVAILABLE_VARIABLES,
    defaultSettings: DEFAULT_PROMPT_SETTINGS,
    allowedModels: limits?.allowed_models ?? ['gpt-4o-mini'],
  });
}

async function handleRuns(admin: Admin, body: Record<string, unknown>) {
  const versionId = body.versionId as string | undefined;
  if (!versionId) return jsonResponse({ error: 'missing_version_id' }, 400);
  const { data, error } = await admin
    .from('prompt_test_runs')
    .select('id, version_id, test_case_id, input_sentence, output, valid, error, model, created_at')
    .eq('version_id', versionId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return jsonResponse({ error: 'db_error', message: error.message }, 500);
  return jsonResponse({ ok: true, runs: data ?? [] });
}

async function handleSaveDraft(admin: Admin, userId: string, promptKey: string, body: Record<string, unknown>) {
  const versionId = (body.versionId as string | undefined) ?? null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  const settings = body.settings ?? DEFAULT_PROMPT_SETTINGS;
  const model = typeof body.model === 'string' ? body.model : 'gpt-4o-mini';
  const temperature = body.temperature === undefined ? null : (body.temperature as number | null);
  const basedOn = (body.basedOnVersionId as string | undefined) ?? null;

  const errors: string[] = [];
  if (!instructions.trim()) errors.push('instructions가 비어 있습니다.');
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) errors.push(`instructions는 ${MAX_INSTRUCTIONS_CHARS}자 이하여야 합니다.`);
  const tpl = checkTemplate(instructions);
  if (tpl.unknownVariables.length > 0) errors.push(`알 수 없는 변수: ${tpl.unknownVariables.map((v) => `{{${v}}}`).join(', ')}`);
  if (tpl.malformed) errors.push('{{ }} 형식이 잘못된 부분이 있습니다.');
  errors.push(...validateSettings(settings));
  if (!isValidTemperature(temperature)) errors.push('temperature는 비우거나 0~2 사이여야 합니다.');
  const { data: limits } = await admin.from('ai_rate_limits').select('allowed_models').eq('user_id', userId).maybeSingle();
  const allowed: string[] = limits?.allowed_models ?? ['gpt-4o-mini'];
  if (!allowed.includes(model)) errors.push(`허용되지 않은 모델: ${model} (허용: ${allowed.join(', ')})`);
  if (errors.length > 0) return jsonResponse({ error: 'validation_failed', errors }, 400);

  const content = { instructions, settings, model, temperature };
  if (versionId) {
    const { data: existing } = await admin.from('prompt_versions').select('status').eq('id', versionId).maybeSingle();
    if (!existing) return jsonResponse({ error: 'version_not_found' }, 404);
    if (existing.status !== 'draft') {
      return jsonResponse({ error: 'not_a_draft', message: '활성/보관 버전은 수정할 수 없습니다. 새 초안을 만드세요.' }, 409);
    }
    const { data, error } = await admin.from('prompt_versions').update(content).eq('id', versionId).select('id, version_no, updated_at').single();
    if (error) return jsonResponse({ error: 'db_error', message: error.message }, 400);
    return jsonResponse({ ok: true, version: data });
  }

  const { data, error } = await admin
    .from('prompt_versions')
    .insert({ prompt_key: promptKey, ...content, based_on_version_id: basedOn, created_by: userId })
    .select('id, version_no, updated_at')
    .single();
  if (error) return jsonResponse({ error: 'db_error', message: error.message }, 400);
  return jsonResponse({ ok: true, version: data });
}

async function handleDeleteDraft(admin: Admin, body: Record<string, unknown>) {
  const versionId = body.versionId as string | undefined;
  if (!versionId) return jsonResponse({ error: 'missing_version_id' }, 400);
  const { error } = await admin.from('prompt_versions').delete().eq('id', versionId).eq('status', 'draft');
  if (error) return jsonResponse({ error: 'db_error', message: error.message }, 400);
  return jsonResponse({ ok: true });
}

/** Restore = copy an old version into a NEW draft. The old row is never revived. */
async function handleRestore(admin: Admin, userId: string, body: Record<string, unknown>) {
  const versionId = body.versionId as string | undefined;
  if (!versionId) return jsonResponse({ error: 'missing_version_id' }, 400);
  const { data: source } = await admin
    .from('prompt_versions')
    .select('prompt_key, version_no, instructions, settings, model, temperature')
    .eq('id', versionId)
    .maybeSingle();
  if (!source) return jsonResponse({ error: 'version_not_found' }, 404);
  const { data, error } = await admin
    .from('prompt_versions')
    .insert({
      prompt_key: source.prompt_key,
      instructions: source.instructions,
      settings: source.settings,
      model: source.model,
      temperature: source.temperature,
      based_on_version_id: versionId,
      created_by: userId,
    })
    .select('id, version_no, updated_at')
    .single();
  if (error) return jsonResponse({ error: 'db_error', message: error.message }, 400);
  return jsonResponse({ ok: true, version: data, restoredFrom: source.version_no });
}

async function handlePreview(admin: Admin, userId: string, promptKey: string, body: Record<string, unknown>) {
  const versionId = body.versionId as string | undefined;
  const testCaseId = (body.testCaseId as string | undefined) ?? null;
  const customSentence = typeof body.sentence === 'string' ? body.sentence.trim() : '';
  if (!versionId) return jsonResponse({ error: 'missing_version_id' }, 400);
  if (!testCaseId && !customSentence) return jsonResponse({ error: 'missing_sentence_or_test_case' }, 400);

  const { data: version } = await admin
    .from('prompt_versions')
    .select('id, version_no, instructions, settings, model, temperature, prompt_key')
    .eq('id', versionId)
    .maybeSingle();
  if (!version || version.prompt_key !== promptKey) return jsonResponse({ error: 'version_not_found' }, 404);

  let sentence = customSentence;
  let expectations: TestCaseExpectations | null = null;
  if (testCaseId) {
    const { data: tc } = await admin.from('prompt_test_cases').select('expression_fr, expectations').eq('id', testCaseId).maybeSingle();
    if (!tc) return jsonResponse({ error: 'test_case_not_found' }, 404);
    sentence = tc.expression_fr;
    expectations = (tc.expectations ?? null) as TestCaseExpectations | null;
  }

  // Gates: kill switch, limits, budget (no 1-concurrent lock -- the admin UI
  // deliberately runs up to 3 previews in parallel).
  const { data: config } = await admin.from('ai_system_config').select('*').eq('id', true).single();
  if (!config?.ai_enabled) return jsonResponse({ error: 'ai_disabled' }, 503);
  const { data: limits } = await admin.from('ai_rate_limits').select('*').eq('user_id', userId).single();
  if (!limits) return jsonResponse({ error: 'rate_limits_not_provisioned' }, 500);
  if (sentence.length > limits.max_input_chars) return jsonResponse({ error: 'input_too_long' }, 400);
  const budgetError = await checkBudget(admin, userId, config);
  if (budgetError) return budgetError;
  if (!OPENAI_API_KEY) return jsonResponse({ error: 'openai_key_not_configured' }, 500);

  let prompt;
  try {
    prompt = buildLoadedPrompt(promptKey, version as PromptVersionRow);
  } catch (err) {
    return jsonResponse({ error: 'template_error', message: err instanceof Error ? err.message : 'template_error' }, 400);
  }
  const allowed: string[] = limits.allowed_models ?? ['gpt-4o-mini'];
  if (!allowed.includes(version.model)) return jsonResponse({ error: 'model_not_allowed', message: version.model }, 400);

  // Same context analyze-lemma would give the model -- READ ONLY.
  const [{ data: lemmaRows }, { data: usageRows }] = await Promise.all([
    admin.from('lemmas').select('id, lemma, part_of_speech').eq('user_id', userId),
    admin.from('lemma_usages').select('id, lemma_id, label, meaning_ko, pattern').eq('user_id', userId),
  ]);
  const context: ExistingLemmaContext[] = (lemmaRows ?? []).map((l) => ({
    id: l.id,
    lemma: l.lemma,
    part_of_speech: l.part_of_speech,
    usages: (usageRows ?? []).filter((u) => u.lemma_id === l.id).map((u) => ({ id: u.id, label: u.label, meaning_ko: u.meaning_ko, pattern: u.pattern })),
  }));

  const { data: logRow } = await admin
    .from('ai_usage_log')
    .insert({ user_id: userId, feature: 'prompt_admin', model: version.model, status: 'reserved' })
    .select('id')
    .single();

  let output: unknown = null;
  let errorText: string | null = null;
  let validationErrors: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const completion = await callOpenAIJsonSchema({
      apiKey: OPENAI_API_KEY,
      systemPrompt: prompt.systemPrompt,
      userPrompt: buildUserPrompt(sentence, context),
      model: version.model,
      schema: ANALYZE_RESPONSE_SCHEMA,
      schemaName: 'lemma_analysis',
      maxOutputTokens: 1200,
      temperature: prompt.temperature,
    });
    output = completion.parsed;
    inputTokens = completion.inputTokens;
    outputTokens = completion.outputTokens;
    validationErrors = validateSentenceAnalysis(output, {
      sentence,
      existingUsageIds: (usageRows ?? []).map((u) => u.id),
      expectations,
    });
  } catch (err) {
    errorText = err instanceof Error ? err.message.slice(0, 500) : 'unknown_error';
    console.error('[admin-prompts] preview call failed', `v${version.version_no}`, errorText.slice(0, 80));
  }

  const pricing = MODEL_PRICING_PER_1M_TOKENS[version.model] ?? MODEL_PRICING_PER_1M_TOKENS['gpt-4o-mini'];
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  if (logRow?.id) {
    await admin
      .from('ai_usage_log')
      .update({ status: errorText ? 'failed' : 'completed', input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost_usd: cost })
      .eq('id', logRow.id);
  }
  if (cost > 0) await admin.rpc('increment_ai_usage', { p_user_id: userId, p_cost_usd: cost });

  const valid = !errorText && validationErrors.length === 0;
  const { data: run, error: runError } = await admin
    .from('prompt_test_runs')
    .insert({
      version_id: version.id,
      test_case_id: testCaseId,
      input_sentence: sentence,
      output,
      valid,
      error: errorText ?? (validationErrors.length > 0 ? validationErrors.join(' | ') : null),
      model: version.model,
      created_by: userId,
    })
    .select('id, version_id, test_case_id, input_sentence, output, valid, error, model, created_at')
    .single();
  if (runError) return jsonResponse({ error: 'db_error', message: runError.message }, 500);
  return jsonResponse({ ok: true, run });
}

async function handleActivate(admin: Admin, body: Record<string, unknown>) {
  const versionId = body.versionId as string | undefined;
  const changeNote = typeof body.changeNote === 'string' ? body.changeNote.trim() : '';
  if (!versionId) return jsonResponse({ error: 'missing_version_id' }, 400);
  if (!changeNote) return jsonResponse({ error: 'change_note_required', message: '변경 이유(change_note)를 입력하세요.' }, 400);

  // Re-render server-side before activating: never activate a template that cannot render.
  const { data: version } = await admin
    .from('prompt_versions')
    .select('id, version_no, instructions, settings, model, temperature, prompt_key')
    .eq('id', versionId)
    .maybeSingle();
  if (!version) return jsonResponse({ error: 'version_not_found' }, 404);
  try {
    buildLoadedPrompt(version.prompt_key, version as PromptVersionRow);
  } catch (err) {
    return jsonResponse({ error: 'template_error', message: err instanceof Error ? err.message : 'template_error' }, 400);
  }

  // The DB function enforces: draft only, change_note, full test set passed after the last edit, one active.
  const { data, error } = await admin.rpc('activate_prompt_version', { p_version_id: versionId, p_change_note: changeNote });
  if (error) return jsonResponse({ error: 'activation_rejected', message: error.message }, 409);
  const row = Array.isArray(data) ? data[0] : data;
  return jsonResponse({ ok: true, activatedVersionId: row?.activated_version_id, archivedVersionId: row?.archived_version_id });
}

async function checkBudget(
  admin: Admin,
  userId: string,
  config: { daily_budget_usd: number; monthly_budget_usd: number }
): Promise<Response | null> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from('ai_daily_usage').select('estimated_cost_usd').eq('user_id', userId).eq('usage_date', today).maybeSingle();
  if ((usage?.estimated_cost_usd ?? 0) >= config.daily_budget_usd) return jsonResponse({ error: 'daily_budget_exceeded' }, 429);
  const month = `${today.slice(0, 7)}-01`;
  const { data: monthly } = await admin.from('ai_monthly_usage').select('estimated_cost_usd').eq('user_id', userId).eq('usage_month', month).maybeSingle();
  if ((monthly?.estimated_cost_usd ?? 0) >= config.monthly_budget_usd) return jsonResponse({ error: 'monthly_budget_exceeded' }, 429);
  const { count } = await admin
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('feature', 'prompt_admin')
    .gte('created_at', `${today}T00:00:00Z`);
  if ((count ?? 0) >= MAX_PREVIEWS_PER_DAY) return jsonResponse({ error: 'daily_preview_limit_exceeded', max: MAX_PREVIEWS_PER_DAY }, 429);
  return null;
}
