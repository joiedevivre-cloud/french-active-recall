import { describe, expect, it } from 'vitest';
import {
  LIGHT_RESULT_ITEM_SCHEMA,
  DETAILED_RESULT_ITEM_SCHEMA,
  CORE_PATTERN_SCHEMA,
  buildResponseSchema,
  computeMaxOutputTokens,
  MAX_TOTAL_OUTPUT_TOKENS,
  MAX_DETAILED_OUTPUT_TOKENS,
  MAX_DETAILED_SENTENCES,
  GRAMMAR_POINT_SCHEMA,
  VOCABULARY_ITEM_SCHEMA,
} from '../../../supabase/functions/_shared/detailedAnalysisSchema';

// Same file analyze-batch (Deno) imports -- see supabase/functions/_shared/
// lemmaMatching.ts for why this pattern (one copy, dual-imported) is used
// instead of re-declaring the schema here.

function collectRequiredKeys(schema: { required?: string[] }): string[] {
  return schema.required ?? [];
}

describe('DETAILED_RESULT_ITEM_SCHEMA (OpenAI strict mode)', () => {
  it('is a strict schema: additionalProperties false, every property required', () => {
    expect(DETAILED_RESULT_ITEM_SCHEMA.additionalProperties).toBe(false);
    const propertyKeys = Object.keys(DETAILED_RESULT_ITEM_SCHEMA.properties);
    const requiredKeys = collectRequiredKeys(DETAILED_RESULT_ITEM_SCHEMA);
    expect(new Set(requiredKeys)).toEqual(new Set(propertyKeys));
  });

  it('includes core_pattern as the v2 primary field, nullable', () => {
    expect(DETAILED_RESULT_ITEM_SCHEMA.properties.core_pattern).toBe(CORE_PATTERN_SCHEMA);
    expect(CORE_PATTERN_SCHEMA.type).toEqual(['object', 'null']);
    expect(new Set(CORE_PATTERN_SCHEMA.required)).toEqual(
      new Set(['pattern', 'meaning_ko', 'matched_form', 'explanation_ko'])
    );
    expect(CORE_PATTERN_SCHEMA.additionalProperties).toBe(false);
  });

  it('still carries every v1 field (no accidental removal)', () => {
    const v1Fields = [
      'expression_fr', 'corrected_fr', 'meaning_ko', 'grammar_note', 'example_fr',
      'example_translation_ko', 'cefr_level', 'tags', 'key_phrase',
      'sentence_structure', 'grammar_points', 'vocabulary', 'common_mistakes',
      'similar_expressions', 'example_sentences',
    ];
    for (const field of v1Fields) {
      expect(DETAILED_RESULT_ITEM_SCHEMA.properties).toHaveProperty(field);
      expect(DETAILED_RESULT_ITEM_SCHEMA.required).toContain(field);
    }
  });
});

describe('LIGHT_RESULT_ITEM_SCHEMA unaffected by the v2 change', () => {
  it('has no core_pattern field (light mode never generates it)', () => {
    expect(LIGHT_RESULT_ITEM_SCHEMA.properties).not.toHaveProperty('core_pattern');
  });
});

describe('buildResponseSchema', () => {
  it('wraps any item schema in a strict {results: [...]} envelope', () => {
    const wrapped = buildResponseSchema(DETAILED_RESULT_ITEM_SCHEMA);
    expect(wrapped.required).toEqual(['results']);
    expect(wrapped.additionalProperties).toBe(false);
    expect(wrapped.properties.results.items).toBe(DETAILED_RESULT_ITEM_SCHEMA);
  });
});

describe('computeMaxOutputTokens (truncation-bug regression guard)', () => {
  it('scales with sentence count up to the hard ceiling', () => {
    expect(computeMaxOutputTokens(1, 4000, false)).toBeLessThan(MAX_TOTAL_OUTPUT_TOKENS);
    expect(computeMaxOutputTokens(50, 4000, false)).toBe(MAX_TOTAL_OUTPUT_TOKENS);
  });

  it('never exceeds its hard ceiling even with a huge configured ceiling', () => {
    expect(computeMaxOutputTokens(50, 1_000_000, false)).toBe(MAX_TOTAL_OUTPUT_TOKENS);
    expect(computeMaxOutputTokens(50, 1_000_000, true)).toBe(MAX_DETAILED_OUTPUT_TOKENS);
  });

  it('v3: detailed mode gets room for the larger output, light/bulk stays capped at 4000', () => {
    // 0017 raises ai_rate_limits.max_output_tokens to 8000 for exactly this.
    const detailed = computeMaxOutputTokens(MAX_DETAILED_SENTENCES, 8000, true);
    expect(detailed).toBeGreaterThan(4000);
    expect(detailed).toBeLessThanOrEqual(MAX_DETAILED_OUTPUT_TOKENS);
    expect(computeMaxOutputTokens(20, 8000, false)).toBe(MAX_TOTAL_OUTPUT_TOKENS);
  });

  it('still respects a lower per-user configured ceiling (cost guard)', () => {
    expect(computeMaxOutputTokens(MAX_DETAILED_SENTENCES, 4000, true)).toBe(4000);
  });

  it('detailed mode (v2, core_pattern added) still fits one sentence comfortably under the ceiling', () => {
    // MAX_DETAILED_SENTENCES=1 is a hard server-side limit -- detailed
    // mode never has to multiply its larger per-item estimate across a
    // chunk, which is what makes raising DETAILED_TOKENS_PER_ITEM_ESTIMATE
    // for the new core_pattern field safe without reintroducing truncation.
    const tokens = computeMaxOutputTokens(MAX_DETAILED_SENTENCES, 8000, true);
    expect(tokens).toBeGreaterThan(2000); // raised from v1's ~2000 ceiling
    expect(tokens).toBeLessThanOrEqual(MAX_DETAILED_OUTPUT_TOKENS);
  });
});

// OpenAI strict mode rejects the WHOLE request (-> a 4xx that surfaces as
// "openai_http_400") if any nested object misses additionalProperties:false
// or leaves a property out of `required`. Walk the entire v3 tree.
function assertStrictEverywhere(schema: any, path: string) {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect([...(schema.required ?? [])].sort(), `${path}.required`).toEqual(Object.keys(schema.properties ?? {}).sort());
    for (const [k, v] of Object.entries(schema.properties ?? {})) assertStrictEverywhere(v, `${path}.${k}`);
  }
  if (types.includes('array')) assertStrictEverywhere(schema.items, `${path}[]`);
}

describe('detailed-v3 schema', () => {
  it('is strict-mode valid at every nesting level', () => {
    assertStrictEverywhere(buildResponseSchema(DETAILED_RESULT_ITEM_SCHEMA), 'root');
    assertStrictEverywhere(buildResponseSchema(LIGHT_RESULT_ITEM_SCHEMA), 'light');
  });

  it('grammar points carry the Construction fields + alternatives', () => {
    for (const key of ['required_complement', 'mood_requirement', 'preposition_rule', 'form_in_sentence', 'incorrect_example', 'alternatives', 'learning_tips']) {
      expect(GRAMMAR_POINT_SCHEMA.required).toContain(key);
    }
    // legacy fields kept so v1/v2 rows and v3 rows share one renderer
    for (const key of ['pattern', 'meaning', 'example']) expect(GRAMMAR_POINT_SCHEMA.required).toContain(key);
  });

  it('uses the same complement/mood enums as lemma_usages (migration 0016)', () => {
    expect(GRAMMAR_POINT_SCHEMA.properties.required_complement.enum).toEqual(['nom', 'pronom', 'infinitif', 'clause', 'independent']);
    expect(GRAMMAR_POINT_SCHEMA.properties.mood_requirement.enum).toEqual(['indicatif', 'subjonctif', 'conditionnel', 'none']);
  });

  it('vocabulary separates a real sentence error from a general learning point', () => {
    expect(VOCABULARY_ITEM_SCHEMA.required).toContain('sentence_error');
    expect(VOCABULARY_ITEM_SCHEMA.required).toContain('learning_point');
    expect(VOCABULARY_ITEM_SCHEMA.required).not.toContain('common_mistake');
  });

  it('adds structure_components for multi-word grammatical relations', () => {
    expect(DETAILED_RESULT_ITEM_SCHEMA.required).toContain('structure_components');
  });
});
