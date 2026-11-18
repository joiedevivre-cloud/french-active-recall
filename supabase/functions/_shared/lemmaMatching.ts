// Pure decision logic for analyze-lemma, pulled out of the Edge Function so
// it can be unit-tested from Vitest too (see
// src/features/vocabulary/lemmaMatching.test.ts, which imports this same
// file by relative path -- there must be exactly one copy of this logic).
// No Deno-specific APIs here.

export function shouldSkipAnalysis(hasExistingAnalysis: boolean, force: boolean): boolean {
  return hasExistingAnalysis && !force;
}

/**
 * Validates that an AI-suggested existing_usage_id actually belongs to the
 * lemma it was offered alongside -- the model hallucinating or reusing a
 * stale id must not silently attach a sentence to the wrong usage.
 */
export function resolveExistingUsageId(
  aiSuggestedUsageId: string | null,
  usagesForThisLemma: { id: string }[]
): string | null {
  if (!aiSuggestedUsageId) return null;
  return usagesForThisLemma.some((u) => u.id === aiSuggestedUsageId) ? aiSuggestedUsageId : null;
}

export function shouldCreateNewUsage(resolvedUsageId: string | null): boolean {
  return resolvedUsageId === null;
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

/** Same protection for a usage's label: a hand-edited label is never renamed by re-analysis. */
export function shouldPreserveUserEditedLabel(existingUsage: { label_user_edited: boolean } | null): boolean {
  return existingUsage?.label_user_edited === true;
}

export function shouldRetryAfterSchemaFailure(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}
