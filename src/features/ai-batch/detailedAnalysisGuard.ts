import type { DetailedBatchItemResult } from '@/features/ai-batch/aiBatchClient';

/**
 * Deterministic consistency check on a detailed analysis BEFORE it is
 * saved -- the prompt asks the model not to contradict the input
 * sentence, but this makes the most visible failure impossible instead of
 * merely unlikely (README "실제 오류 vs 학습 포인트").
 *
 * - The sentence is correct (corrected_fr is null or identical to the
 *   input) -> no vocabulary item may claim a sentence_error. This is the
 *   "fatigue: gender agreement" / "apprendre: wrong verb form" false
 *   warning bug: a claimed error on a correct sentence is dropped.
 * - An incorrect_example that is just the (correct) input sentence itself
 *   is a contradiction -> dropped.
 * - An "alternative" whose rewritten_sentence is the input itself is not
 *   an alternative -> dropped.
 * - mood_requirement only makes sense for a clause complement -> forced
 *   to 'none' otherwise, so the UI never prints "infinitif au subjonctif".
 *
 * Pure function: returns a new object, never mutates its input.
 */
export function guardDetailedResult(result: DetailedBatchItemResult): DetailedBatchItemResult {
  const original = normalizeSentence(result.expression_fr);
  const sentenceIsCorrect = !result.corrected_fr || normalizeSentence(result.corrected_fr) === original;

  const vocabulary = (result.vocabulary ?? []).map((v) =>
    sentenceIsCorrect && v.sentence_error ? { ...v, sentence_error: null } : v
  );

  const grammar_points = (result.grammar_points ?? []).map((gp) => {
    const next = { ...gp };
    if (next.required_complement && next.required_complement !== 'clause' && next.mood_requirement && next.mood_requirement !== 'none') {
      next.mood_requirement = 'none';
    }
    if (sentenceIsCorrect && next.incorrect_example && normalizeSentence(next.incorrect_example.fr) === original) {
      next.incorrect_example = null;
    }
    if (next.alternatives) {
      next.alternatives = next.alternatives
        .filter((alt) => normalizeSentence(alt.rewritten_sentence) !== original)
        .map((alt) =>
          alt.required_complement !== 'clause' && alt.mood_requirement !== 'none' ? { ...alt, mood_requirement: 'none' as const } : alt
        );
    }
    return next;
  });

  return { ...result, vocabulary, grammar_points };
}

function normalizeSentence(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*([.!?…,;:])\s*$/u, '');
}
