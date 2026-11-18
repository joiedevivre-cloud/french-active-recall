import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  DETAILED_PROMPT_VERSION,
  DETAILED_SYSTEM_PROMPT_EXTRA,
  LIGHT_SYSTEM_PROMPT_HEADER,
  TERMINOLOGY_RULES,
} from '../../../supabase/functions/_shared/prompts/detailedAnalysis';
import {
  ALTERNATIVE_SCHEMA,
  DETAILED_RESULT_ITEM_SCHEMA,
  GRAMMAR_POINT_SCHEMA,
  LIGHT_RESULT_ITEM_SCHEMA,
  STRUCTURE_COMPONENT_SCHEMA,
  VOCABULARY_ITEM_SCHEMA,
} from '../../../supabase/functions/_shared/detailedAnalysisSchema';
import { DETAILED_ANALYSIS_VERSION } from '@/features/ai-batch/applyAnalysisResult';

// "프롬프트, JSON Schema, 저장 로직, UI가 모두 일치해야 합니다" -- every field
// the schema forces the model to output must be explained by the prompt
// (otherwise strict mode makes the model fill it with guesses).

function mentions(prompt: string, field: string) {
  return prompt.includes(field);
}

describe('detailed-v3 prompt <-> schema consistency', () => {
  const detailed = buildSystemPrompt(1, true);

  it('describes every top-level detailed field', () => {
    for (const key of DETAILED_RESULT_ITEM_SCHEMA.required) {
      expect(mentions(detailed, key), key).toBe(true);
    }
  });

  it('describes every grammar point / alternative / vocabulary / structure field', () => {
    for (const key of [
      ...GRAMMAR_POINT_SCHEMA.required,
      ...ALTERNATIVE_SCHEMA.required,
      ...VOCABULARY_ITEM_SCHEMA.required,
      ...STRUCTURE_COMPONENT_SCHEMA.required,
    ]) {
      expect(mentions(detailed, key), key).toBe(true);
    }
  });

  it('light prompt describes every light field and does not ask for detailed-only fields', () => {
    const light = buildSystemPrompt(5, false);
    for (const key of LIGHT_RESULT_ITEM_SCHEMA.required) expect(mentions(light, key), key).toBe(true);
    expect(light).not.toContain('grammar_points');
  });

  it('saved analysis_version matches the prompt version', () => {
    expect(DETAILED_ANALYSIS_VERSION).toBe(DETAILED_PROMPT_VERSION);
  });
});

describe('French grammar terminology rule', () => {
  it('applies to both light and detailed prompts', () => {
    expect(LIGHT_SYSTEM_PROMPT_HEADER).toContain(TERMINOLOGY_RULES);
    expect(buildSystemPrompt(1, true)).toContain(TERMINOLOGY_RULES);
  });

  it('lists the standard terms from the spec', () => {
    for (const term of [
      'groupe nominal (GN)',
      'indicatif',
      'subjonctif',
      'proposition indépendante',
      'proposition principale',
      'proposition subordonnée',
      'infinitif',
      'verbe pronominal',
      'préposition',
      'accord en genre et en nombre',
    ]) {
      expect(TERMINOLOGY_RULES).toContain(term);
    }
  });
});

describe('false-error and contradiction rules are in the prompt', () => {
  it('forbids sentence_error on a correct sentence (the fatigue/apprendre false warnings)', () => {
    expect(DETAILED_SYSTEM_PROMPT_EXTRA).toMatch(/corrected_fr is null[^.]*MUST be null/);
    expect(DETAILED_SYSTEM_PROMPT_EXTRA).toContain('la fatigue');
    expect(DETAILED_SYSTEM_PROMPT_EXTRA).toContain('apprendre');
  });

  it('requires grammar_points[0] to be the core construction and covers the spec examples', () => {
    expect(DETAILED_SYSTEM_PROMPT_EXTRA).toContain("grammar_points[0] MUST be the core_pattern's construction");
    for (const p of ['continuer à', 'se rendre compte que', 'se mettre à', 'malgré', 'bien que', 'même si', 'pourtant', 'en dépit de']) {
      expect(DETAILED_SYSTEM_PROMPT_EXTRA, p).toContain(p);
    }
  });
});
