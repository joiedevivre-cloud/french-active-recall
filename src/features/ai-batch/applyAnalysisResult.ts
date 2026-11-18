import { supabase } from '@/lib/supabase';
import type { BatchItemResult } from '@/features/ai-batch/aiBatchClient';

/**
 * Writes one AI analysis result back onto its expression row (used by both
 * the auto-trigger-after-save path and a manual "재시도" in the library).
 * Passing `result: null` means the analysis failed -- this ONLY flips
 * ai_analysis_status to 'failed' and touches nothing else, so the original
 * expression_fr/meaning_ko the user saved is never lost or altered.
 */
export async function applyAnalysisResult(expressionId: string, result: BatchItemResult | null): Promise<void> {
  if (!result) {
    await supabase.from('expressions').update({ ai_analysis_status: 'failed' }).eq('id', expressionId);
    return;
  }

  await supabase
    .from('expressions')
    .update({
      meaning_ko: result.meaning_ko,
      grammar_note: result.grammar_note,
      cefr_level: result.cefr_level,
      corrected_fr: result.corrected_fr,
      key_phrase: result.key_phrase,
      ai_analysis_status: 'completed',
    })
    .eq('id', expressionId);

  if (!result.example_fr) return;

  // No client-side idempotency key on expression_examples -- check-then-write
  // so re-running analysis for the same expression doesn't pile up examples.
  const { data: existing } = await supabase
    .from('expression_examples')
    .select('id')
    .eq('expression_id', expressionId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('expression_examples')
      .update({ sentence_fr: result.example_fr, translation_ko: result.example_translation_ko })
      .eq('id', existing.id);
  } else {
    await supabase.from('expression_examples').insert({
      expression_id: expressionId,
      sentence_fr: result.example_fr,
      translation_ko: result.example_translation_ko,
      is_user_created: false,
    });
  }
}
