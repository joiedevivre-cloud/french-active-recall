import { supabase } from '@/lib/supabase';
import type { BatchItemResult, DetailedBatchItemResult } from '@/features/ai-batch/aiBatchClient';
import { guardDetailedResult } from '@/features/ai-batch/detailedAnalysisGuard';

// v2: added core_pattern (multi-word idiomatic/semi-auxiliary pattern
// recognition, e.g. "se mettre à + infinitif") as the primary field --
// v1's sentence_structure only fit subordinate-clause sentences, so a
// sentence like "Je me suis mise à chercher..." got nothing but a
// word-by-word vocabulary breakdown. See README "AI 분석 품질".
// v3: Construction grammaticale cards (required_complement/mood/preposition
// + alternatives), structure_components, sentence_error vs learning_point,
// French grammar terminology. Must match DETAILED_PROMPT_VERSION in
// supabase/functions/_shared/prompts/detailedAnalysis.ts.
export const DETAILED_ANALYSIS_VERSION = 'detailed-v3';

function isDetailedResult(result: BatchItemResult | DetailedBatchItemResult): result is DetailedBatchItemResult {
  return 'sentence_structure' in result;
}

/**
 * Stamps every given expression as "a request is actually in flight right
 * now", BEFORE calling analyze-batch. Without this, a row sits at
 * 'pending' (or stays 'failed') while genuinely being retried, which is
 * exactly what made a stuck request indistinguishable from one nobody had
 * asked to analyze yet. See src/features/ai-batch/staleAnalysis.ts for how
 * a request that never comes back gets detected later.
 */
export async function markAnalyzing(expressionIds: string[]): Promise<void> {
  if (expressionIds.length === 0) return;
  await supabase
    .from('expressions')
    .update({ ai_analysis_status: 'analyzing', analysis_requested_at: new Date().toISOString() })
    .in('id', expressionIds);
}

/**
 * Writes one AI analysis result back onto its expression row (used by the
 * auto-trigger-after-save path, the library's individual/batch retry, and
 * the detail screen's "AI 다시 분석"). Passing `result: null` means the
 * analysis failed -- this ONLY flips ai_analysis_status to 'failed' and
 * touches nothing else, so the original expression_fr/meaning_ko/detailed
 * analysis the user already has is never lost or altered.
 *
 * If the user has manually edited meaning_ko (meaning_ko_user_edited），
 * re-analysis NEVER overwrites it -- every other field still updates
 * normally, since the user only asked to protect the meaning they typed,
 * not to freeze the whole row.
 */
export async function applyAnalysisResult(
  expressionId: string,
  result: BatchItemResult | DetailedBatchItemResult | null
): Promise<void> {
  if (!result) {
    await supabase.from('expressions').update({ ai_analysis_status: 'failed' }).eq('id', expressionId);
    return;
  }

  const { data: current } = await supabase
    .from('expressions')
    .select('meaning_ko_user_edited')
    .eq('id', expressionId)
    .maybeSingle();

  const update: Record<string, unknown> = {
    grammar_note: result.grammar_note,
    cefr_level: result.cefr_level,
    corrected_fr: result.corrected_fr,
    key_phrase: result.key_phrase,
    ai_analysis_status: 'completed',
  };
  if (!current?.meaning_ko_user_edited) {
    update.meaning_ko = result.meaning_ko;
  }

  if (isDetailedResult(result)) {
    // Drop self-contradicting claims (e.g. an error warning on a correct
    // sentence) before they are cached -- see detailedAnalysisGuard.ts.
    const guarded = guardDetailedResult(result);
    update.detailed_analysis = {
      core_pattern: guarded.core_pattern,
      sentence_structure: guarded.sentence_structure,
      structure_components: guarded.structure_components ?? [],
      grammar_points: guarded.grammar_points,
      vocabulary: guarded.vocabulary,
      common_mistakes: result.common_mistakes,
      similar_expressions: result.similar_expressions,
      example_sentences: result.example_sentences,
    };
    update.analyzed_at = new Date().toISOString();
    update.analysis_version = DETAILED_ANALYSIS_VERSION;
  }

  await supabase.from('expressions').update(update).eq('id', expressionId);

  // expression_examples still gets ONE representative example (used by
  // TodayReview's fill-in-the-blank card) regardless of detailed mode --
  // detailed's example_sentences[0] doubles as that representative example.
  const exampleFr = isDetailedResult(result) ? result.example_sentences[0]?.fr ?? result.example_fr : result.example_fr;
  const exampleKo = isDetailedResult(result) ? result.example_sentences[0]?.ko ?? result.example_translation_ko : result.example_translation_ko;
  if (!exampleFr) return;

  // No client-side idempotency key on expression_examples -- check-then-write
  // so re-running analysis for the same expression doesn't pile up examples.
  const { data: existing } = await supabase
    .from('expression_examples')
    .select('id')
    .eq('expression_id', expressionId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    await supabase.from('expression_examples').update({ sentence_fr: exampleFr, translation_ko: exampleKo }).eq('id', existing.id);
  } else {
    await supabase.from('expression_examples').insert({
      expression_id: expressionId,
      sentence_fr: exampleFr,
      translation_ko: exampleKo,
      is_user_created: false,
    });
  }
}
