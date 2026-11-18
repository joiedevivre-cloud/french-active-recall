// One-off admin script: backfills expression_analysis (단어장: lemma +
// usage + pronunciation + grammar) for expressions saved before the
// analyze-lemma Edge Function existed, or whenever force-regenerating many
// at once. Can't reuse the Edge Function here -- it requires a user JWT,
// and this script runs with no logged-in session -- so it talks to OpenAI
// and the DB directly with the service role key, reusing the exact same
// prompt/schema file the Edge Function uses so results never diverge.
//
// Usage:
//   npx tsx scripts/backfill-analysis.ts --dry-run
//   npx tsx scripts/backfill-analysis.ts --user-id <uuid> [--force] [--limit 100]
//
// Requires .env.local with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY.
import { createClient } from '@supabase/supabase-js';
import {
  ANALYZE_SYSTEM_PROMPT,
  ANALYZE_RESPONSE_SCHEMA,
  PROMPT_VERSION,
  buildUserPrompt,
  type AnalyzeAiResult,
  type ExistingLemmaContext,
} from '../supabase/functions/_shared/prompts/analyze.ts';
import {
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldPreserveField,
  shouldRetryAfterSchemaFailure,
} from '../supabase/functions/_shared/lemmaMatching.ts';

try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local is optional -- CI/shell-exported env vars are also accepted.
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';
const CONCURRENCY = 3;
const MAX_SCHEMA_RETRY_ATTEMPTS = 2;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const userIdArg = args.find((a) => a.startsWith('--user-id='))?.split('=')[1];
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? parseInt(limitArg, 10) : undefined;

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Add them to .env.local (never commit this file).');
    process.exit(1);
  }
  if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local.');
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: config } = await admin.from('ai_system_config').select('ai_enabled').eq('id', true).single();
  if (!config?.ai_enabled) {
    console.error('ai_system_config.ai_enabled is false -- refusing to call OpenAI. Flip it on first if this is intentional.');
    process.exit(1);
  }

  let query = admin.from('expressions').select('id, user_id, expression_fr');
  if (userIdArg) query = query.eq('user_id', userIdArg);
  if (limit) query = query.limit(limit);
  const { data: expressions, error: exprError } = await query;
  if (exprError || !expressions) {
    console.error('Failed to load expressions:', exprError?.message);
    process.exit(1);
  }

  const { data: existingAnalyses } = await admin.from('expression_analysis').select('expression_id, lemma_id, usage_id, usage_user_assigned');
  const existingByExprId = new Map((existingAnalyses ?? []).map((r) => [r.expression_id, r]));

  const targets = force ? expressions : expressions.filter((e) => !existingByExprId.has(e.id));
  console.log(`${expressions.length} expressions total, ${targets.length} to ${force ? 'force-reanalyze' : 'backfill'} (dry-run: ${dryRun}).`);

  if (dryRun) {
    console.log(`Would call OpenAI ${targets.length} times. No changes made.`);
    return;
  }

  let done = 0;
  let succeeded = 0;
  let failed = 0;

  // Small fixed-size worker pool -- no external dependency needed for a
  // concurrency limit of 3.
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const expr = targets[cursor++];
      try {
        await analyzeOne(admin, expr, existingByExprId.get(expr.id) ?? null);
        succeeded++;
      } catch (err) {
        failed++;
        console.error(`[FAILED] ${expr.id}:`, err instanceof Error ? err.message : err);
      }
      done++;
      if (done % 10 === 0 || done === targets.length) {
        console.log(`progress: ${done}/${targets.length} (ok: ${succeeded}, failed: ${failed})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  console.log(`Done. ${succeeded} succeeded, ${failed} failed out of ${targets.length}.`);
}

async function analyzeOne(
  admin: ReturnType<typeof createClient>,
  expr: { id: string; user_id: string; expression_fr: string },
  existingAnalysis: { lemma_id: string; usage_id: string; usage_user_assigned: boolean } | null
) {
  const { data: existingLemmaRows } = await admin.from('lemmas').select('id, lemma, part_of_speech').eq('user_id', expr.user_id);
  const { data: existingUsageRows } = await admin
    .from('lemma_usages')
    .select('id, lemma_id, label, meaning_ko, pattern')
    .eq('user_id', expr.user_id);
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
      ai = await callOpenAI(expr.expression_fr, existingLemmaContext);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (!shouldRetryAfterSchemaFailure(attempt, MAX_SCHEMA_RETRY_ATTEMPTS - 1)) break;
    }
  }
  if (!ai) throw new Error(lastError ?? 'unknown_error');

  const { data: lemma, error: lemmaError } = await admin
    .from('lemmas')
    .upsert(
      {
        user_id: expr.user_id,
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

  if (preserveAssignment && existingAnalysis) {
    lemmaId = existingAnalysis.lemma_id;
    usageId = existingAnalysis.usage_id;
  } else {
    const { data: usagesForLemma } = await admin.from('lemma_usages').select('id, label, pattern, label_user_edited, user_edited_fields').eq('lemma_id', lemmaId);
    const resolvedId = resolveExistingUsageId(ai.usage.existing_usage_id, ai.usage.pattern, usagesForLemma ?? []);

    let isNewUsageLink = false;
    if (shouldCreateNewUsage(resolvedId)) {
      const { count } = await admin.from('lemma_usages').select('id', { count: 'exact', head: true }).eq('lemma_id', lemmaId);
      const { data: newUsage, error: usageError } = await admin
        .from('lemma_usages')
        .upsert(
          {
            user_id: expr.user_id,
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
      if (Object.keys(update).length > 0) await admin.from('lemma_usages').update(update).eq('id', usageId);
    }

    const { data: existingUsageLink } = await admin.from('expression_analysis').select('expression_id').eq('usage_id', usageId).limit(1).maybeSingle();
    if (!existingUsageLink) isNewUsageLink = true;
    if (isNewUsageLink) {
      await admin.from('review_states').upsert({ user_id: expr.user_id, lemma_usage_id: usageId }, { onConflict: 'user_id,lemma_usage_id', ignoreDuplicates: true });
    }
  }

  const { error: analysisError } = await admin.from('expression_analysis').upsert(
    {
      expression_id: expr.id,
      user_id: expr.user_id,
      lemma_id: lemmaId,
      usage_id: usageId,
      usage_user_assigned: preserveAssignment,
      pronunciation_ipa: ai.sentence_pronunciation.pronunciation_ipa,
      pronunciation_note: ai.sentence_pronunciation.pronunciation_note,
      grammar_points: ai.grammar_points,
      level: ai.level,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
    },
    { onConflict: 'expression_id' }
  );
  if (analysisError) throw new Error(`expression_analysis_upsert_failed: ${analysisError.message}`);

  await admin.rpc('increment_ai_usage', { p_user_id: expr.user_id, p_cost_usd: 0, p_expression_analyses: 1 });
}

async function callOpenAI(sentence: string, existingLemmas: ExistingLemmaContext[]): Promise<AnalyzeAiResult> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      response_format: { type: 'json_schema', json_schema: { name: 'lemma_analysis', strict: true, schema: ANALYZE_RESPONSE_SCHEMA } },
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(sentence, existingLemmas) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`openai_http_${response.status}: ${body.slice(0, 500)}`);
  }
  const payload = await response.json();
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('openai_empty_response');
  if (choice?.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error(`output_truncated: finish_reason=${choice.finish_reason}`);
  }
  return JSON.parse(content) as AnalyzeAiResult;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
