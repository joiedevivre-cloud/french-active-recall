// Semantic validation of one sentence-analysis AI output (prompt
// management preview/compare + activation gate). Pure -- used by the
// admin-prompts Edge Function and tested from Vitest.
//
// Strict Structured Outputs already guarantees the JSON *shape*, so a
// shape-only check would pass ~100% and prove nothing. This checks what
// the shape can't: empty fields, non-IPA pronunciations, out-of-range
// counts, an existing_usage_id the model wasn't given, the reflexive
// mettre misclassification, and per-test-case expectations.
import { hasReflexiveMettre, isReflexiveMettreMisassigned, normalizePattern } from './lemmaMatching.ts';

export interface TestCaseExpectations {
  /** normalized pattern must contain this (e.g. "se mettre à") */
  pattern_includes?: string;
  /** normalized pattern must NOT contain this */
  pattern_excludes?: string;
}

export interface ValidationContext {
  sentence: string;
  existingUsageIds: string[];
  expectations?: TestCaseExpectations | null;
}

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const LEVELS = ['A1', 'A2', 'B1', 'B2'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function checkIpa(value: unknown, field: string, errors: string[]) {
  if (!isNonEmptyString(value)) {
    errors.push(`${field}: empty`);
    return;
  }
  const v = value.trim();
  if (!/^[/[].+[/\]]$/.test(v)) errors.push(`${field}: not wrapped in /…/`);
  if (HANGUL_RE.test(v)) errors.push(`${field}: contains Korean transliteration`);
}

export function validateSentenceAnalysis(output: unknown, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  if (!output || typeof output !== 'object') return ['output is not an object'];
  const o = output as Record<string, any>;

  if (!isNonEmptyString(o.lemma)) errors.push('lemma: empty');
  if (!isNonEmptyString(o.part_of_speech)) errors.push('part_of_speech: empty');
  checkIpa(o.pronunciation_ipa, 'pronunciation_ipa', errors);

  const gn = o.grammar_notes;
  if (!gn || typeof gn !== 'object') errors.push('grammar_notes: missing');
  else if (!Array.isArray(gn.common_mistakes) || gn.common_mistakes.length > 3) errors.push('grammar_notes.common_mistakes: must be 0-3 items');

  const usage = o.usage;
  if (!usage || typeof usage !== 'object') {
    errors.push('usage: missing');
  } else {
    if (!isNonEmptyString(usage.label)) errors.push('usage.label: empty');
    if (!isNonEmptyString(usage.meaning_ko)) errors.push('usage.meaning_ko: empty');
    if (!isNonEmptyString(usage.pattern)) errors.push('usage.pattern: empty');
    if (usage.existing_usage_id !== null && usage.existing_usage_id !== undefined && !ctx.existingUsageIds.includes(usage.existing_usage_id)) {
      errors.push('usage.existing_usage_id: not one of the provided usages');
    }
    if (isNonEmptyString(o.lemma) && isNonEmptyString(usage.pattern) && isReflexiveMettreMisassigned(ctx.sentence, o.lemma, usage.pattern)) {
      errors.push('usage.pattern: reflexive "se mettre" sentence assigned to a non-reflexive (basic meaning) usage');
    }
    const exp = ctx.expectations ?? {};
    if (exp.pattern_includes && isNonEmptyString(usage.pattern) && !normalizePattern(usage.pattern).includes(normalizePattern(exp.pattern_includes))) {
      errors.push(`usage.pattern: expected to include "${exp.pattern_includes}"`);
    }
    if (exp.pattern_excludes && isNonEmptyString(usage.pattern) && normalizePattern(usage.pattern).includes(normalizePattern(exp.pattern_excludes))) {
      errors.push(`usage.pattern: must not include "${exp.pattern_excludes}"`);
    }
  }

  const sp = o.sentence_pronunciation;
  if (!sp || typeof sp !== 'object') errors.push('sentence_pronunciation: missing');
  else {
    checkIpa(sp.pronunciation_ipa, 'sentence_pronunciation.pronunciation_ipa', errors);
  }

  if (!Array.isArray(o.grammar_points) || o.grammar_points.length < 1 || o.grammar_points.length > 3) {
    errors.push('grammar_points: must be 1-3 items');
  } else {
    o.grammar_points.forEach((gp: any, i: number) => {
      if (!isNonEmptyString(gp?.form) || !isNonEmptyString(gp?.meaning)) errors.push(`grammar_points[${i}]: form/meaning empty`);
    });
  }

  if (!LEVELS.includes(o.level)) errors.push('level: must be A1/A2/B1/B2');

  return errors;
}

export { hasReflexiveMettre };
