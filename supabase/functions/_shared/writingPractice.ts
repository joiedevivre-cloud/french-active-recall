// Pure decision logic for the writing-practice Edge Function, pulled out
// so it can be unit-tested from Vitest too (see
// src/features/today/writingPractice.test.ts, which imports this exact
// file by relative path -- same "one copy, tested where it runs" pattern
// as supabase/functions/_shared/lemmaMatching.ts). No Deno-specific APIs.

export interface ExerciseCandidate {
  id: string;
  timesUsed: number;
}

/**
 * "Cache generated exercises instead of regenerating identical ones
 * needlessly": an unused (timesUsed === 0) cached exercise for this
 * (expression, mode) is reused with zero AI calls. Once every cached
 * candidate has been used at least once, this returns null -- a genuine
 * cache miss, so a fresh variant gets generated (this is also how
 * "relearning with a new sentence, same grammar pattern" gets variety
 * instead of showing the literal same exercise forever).
 */
export function pickCachedExercise(candidates: ExerciseCandidate[], forceNew: boolean): ExerciseCandidate | null {
  if (forceNew) return null;
  return candidates.find((c) => c.timesUsed === 0) ?? null;
}

export function shouldSkipGeneration(cachedExercise: ExerciseCandidate | null): boolean {
  return cachedExercise !== null;
}

/**
 * Validates/cleans the grammar_error_tags array an AI correction returns
 * before it's used to call record_grammar_attempt once per tag -- a
 * malformed or missing field must never crash the correction response,
 * it just means no grammar_skills update happens for this attempt.
 */
export function sanitizeGrammarTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t === 'string' && t.trim().length > 0) seen.add(t.trim());
  }
  return [...seen];
}

/**
 * The FSRS grade the AI's correction suggests, derived purely from its
 * structured judgement -- never a hard requirement the client must
 * follow (self_rating, the user's own confirmed choice, is the only
 * thing that ever reaches the scheduler). meaning_ok=false always means
 * at least 'again'; grammar/tense/vocab errors (even with meaning_ok=true)
 * cap the suggestion at 'hard'; a clean answer with no errors suggests
 * 'good' (never auto-suggests 'easy' -- that judgement call is left to
 * the user, who knows whether it felt effortless).
 */
export function suggestRatingFromCorrection(input: {
  meaningOk: boolean;
  hasGrammarErrors: boolean;
  hasVocabOrPrepositionErrors: boolean;
  hasTenseOrConjugationErrors: boolean;
}): 'again' | 'hard' | 'good' {
  if (!input.meaningOk) return 'again';
  if (input.hasGrammarErrors || input.hasVocabOrPrepositionErrors || input.hasTenseOrConjugationErrors) return 'hard';
  return 'good';
}
