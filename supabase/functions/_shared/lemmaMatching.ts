// Pure decision logic for analyze-lemma, pulled out of the Edge Function so
// it can be unit-tested from Vitest too (see
// src/features/vocabulary/lemmaMatching.test.ts, which imports this same
// file by relative path -- there must be exactly one copy of this logic).
// No Deno-specific APIs here.
import { canonicalizePattern } from './patternNotation.ts';

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
 * Comparison key for two patterns: standard notation first (qqn / qqch /
 * inf. -- so "nom (사람)" and "groupe nominal (personne)" are the same
 * slot), then normalizePattern. Still an exact construction match.
 */
export function patternKey(pattern: string): string {
  return normalizePattern(canonicalizePattern(pattern));
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
  return patternKey(match.pattern) === patternKey(aiRecognizedPattern) ? aiSuggestedUsageId : null;
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
  const key = patternKey(newPattern);
  return existingUsages.find((u) => u.pattern && patternKey(u.pattern) === key)?.id ?? null;
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

// -----------------------------------------------------------------------------
// Reflexive "mettre" guard (prompt management, stage 1 validation).
//
// NOT the same rule as resolveExistingUsageId above (that one compares an
// AI-suggested usage's stored pattern with the recognized pattern). This one
// looks at the SENTENCE itself: when it contains a reflexive construction of
// mettre (je me mets / je me suis mise / tu te mets / il se met / nous nous
// mettons / vous vous êtes mis / mets-toi ...), the assigned usage pattern
// must be a "se mettre" construction -- a basic-meaning usage (놓다/입다/켜다)
// is a misclassification (the "Je me suis mise à chercher" -> "기기를 켜다" bug).
//
// The pronoun must agree with the subject to count as reflexive, so object
// pronouns are not flagged: "Il me met en colère", "Je te mets au courant".
// -----------------------------------------------------------------------------

const METTRE_FORM_RE = /^(mett\w*|mets|met|mis|mise|mises|mit|mirent)$/;
const ETRE_AUX = new Set([
  'suis', 'es', 'est', 'sommes', 'etes', 'sont', 'etais', 'etait', 'etions', 'etiez', 'etaient',
  'serai', 'seras', 'sera', 'serons', 'serez', 'seront', 'serais', 'serait', 'serions', 'seriez', 'seraient',
  'sois', 'soit', 'soyons', 'soyez', 'soient', 'etre', 'etant', 'ete',
]);
const NEGATION = new Set(['pas', 'jamais', 'plus', 'point', 'rien', 'guere']);
const SUBJECT_FOR_PRONOUN: Record<string, string> = { me: 'je', te: 'tu', nous: 'nous', vous: 'vous' };

function tokenizeFrench(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/\b([mtsjnl])'/g, (_, c: string) => (c === 'l' ? 'le ' : `${c}e `))
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function hasReflexiveMettre(sentence: string): boolean {
  const lowered = sentence.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Imperative: mets-toi, mettez-vous, mettons-nous
  if (/\bmet\w*-(toi|vous|nous)\b/.test(lowered)) return true;

  const tokens = tokenizeFrench(sentence);
  for (let i = 0; i < tokens.length; i++) {
    if (!METTRE_FORM_RE.test(tokens[i])) continue;
    let j = i - 1;
    while (j >= 0 && NEGATION.has(tokens[j])) j--;
    if (j >= 0 && ETRE_AUX.has(tokens[j])) j--;
    if (j < 0) continue;
    const pronoun = tokens[j];
    if (pronoun === 'se') return true;
    const subject = SUBJECT_FOR_PRONOUN[pronoun];
    if (!subject) continue;
    let k = j - 1;
    if (k >= 0 && tokens[k] === 'ne') k--;
    if (k >= 0 && tokens[k] === subject) return true;
  }
  return false;
}

/** true = the sentence uses reflexive mettre but the assigned usage is not a "se mettre" construction. */
export function isReflexiveMettreMisassigned(sentence: string, lemma: string, usagePattern: string): boolean {
  if (!normalizePattern(lemma).includes('mettre')) return false;
  if (!hasReflexiveMettre(sentence)) return false;
  return !normalizePattern(usagePattern).includes('se mettre');
}
