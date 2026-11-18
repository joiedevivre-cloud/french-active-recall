// Pure decision logic for analyze-lemma, pulled out of the Edge Function so
// it can be unit-tested from Vitest too (see
// src/features/vocabulary/lemmaMatching.test.ts, which imports this same
// file by relative path -- there must be exactly one copy of this logic).
// No Deno-specific APIs here.

export function shouldSkipAnalysis(hasExistingAnalysis: boolean, force: boolean): boolean {
  return hasExistingAnalysis && !force;
}

/**
 * Normalizes a French grammar-pattern string for comparison: lowercase,
 * strip accents, collapse whitespace/punctuation. "Se Mettre à + Infinitif"
 * and "se mettre à + infinitif" normalize identically; "mettre à jour" and
 * "mettre en marche" do not -- this is intentionally strict (exact
 * construction match), not fuzzy similarity, per the explicit requirement
 * that usage reuse must never be decided by name/meaning similarity alone.
 */
export function normalizePattern(pattern: string): string {
  return pattern
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Validates that an AI-suggested existing_usage_id ACTUALLY belongs to the
 * lemma it was offered alongside AND that the grammar pattern the AI just
 * recognized in this sentence genuinely matches that usage's own stored
 * pattern (normalized exact match). Catching only the id-ownership case
 * (the old behavior) was not enough -- the model could pick a real,
 * correctly-owned existing_usage_id that was nonetheless the WRONG sense
 * (e.g. matching "Je me suis mise à chercher..." to an existing "mettre en
 * marche" usage just because both share the lemma "mettre"). Requiring an
 * exact pattern match is what actually prevents that misclassification.
 */
export function resolveExistingUsageId(
  aiSuggestedUsageId: string | null,
  aiRecognizedPattern: string,
  usagesForThisLemma: { id: string; pattern: string | null }[]
): string | null {
  if (!aiSuggestedUsageId) return null;
  const match = usagesForThisLemma.find((u) => u.id === aiSuggestedUsageId);
  if (!match || !match.pattern) return null;
  return normalizePattern(match.pattern) === normalizePattern(aiRecognizedPattern) ? aiSuggestedUsageId : null;
}

export function shouldCreateNewUsage(resolvedUsageId: string | null): boolean {
  return resolvedUsageId === null;
}

/**
 * For seed_dictionary: finds an existing usage (of any source) whose
 * stored pattern exactly matches a newly AI-generated dictionary sense,
 * so seeding merges into it instead of creating a near-duplicate. Same
 * strict normalized-match rule as resolveExistingUsageId -- deliberately
 * not reused as the same function since the inputs differ (no
 * AI-suggested id here, just a pattern to find a home for).
 */
export function findMergeTargetUsageId(newPattern: string, existingUsages: { id: string; pattern: string | null }[]): string | null {
  const normalized = normalizePattern(newPattern);
  return existingUsages.find((u) => u.pattern && normalizePattern(u.pattern) === normalized)?.id ?? null;
}

/**
 * A user who manually moved an expression to a different usage
 * (usage_user_assigned=true) must not have that choice silently reverted by
 * a later re-analysis -- the new usage_id/lemma_id the AI suggests is
 * discarded, everything else (pronunciation, grammar_points) still updates.
 */
export function shouldPreserveUserAssignedUsage(existingRow: { usage_user_assigned: boolean } | null): boolean {
  return existingRow?.usage_user_assigned === true;
}

/** Legacy single-purpose protection for a usage's label (kept as-is). */
export function shouldPreserveUserEditedLabel(existingUsage: { label_user_edited: boolean } | null): boolean {
  return existingUsage?.label_user_edited === true;
}

/**
 * General-purpose version of shouldPreserveUserEditedLabel for every
 * other editable usage field (meaning_ko, grammar_explanation_ko,
 * ai_example_sentences, alternatives, common_mistakes_ko, pattern) --
 * lemma_usages.user_edited_fields lists which field names the user has
 * hand-edited; a later AI write (classify reuse or seed_dictionary merge)
 * must skip exactly those fields and update everything else normally.
 */
export function shouldPreserveField(userEditedFields: string[] | null | undefined, fieldName: string): boolean {
  return (userEditedFields ?? []).includes(fieldName);
}

export function shouldRetryAfterSchemaFailure(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}
