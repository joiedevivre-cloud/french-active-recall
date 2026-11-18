import { describe, expect, it } from 'vitest';
import {
  LIGHT_RESULT_ITEM_SCHEMA,
  DETAILED_RESULT_ITEM_SCHEMA,
  CORE_PATTERN_SCHEMA,
  buildResponseSchema,
  computeMaxOutputTokens,
  MAX_TOTAL_OUTPUT_TOKENS,
  MAX_DETAILED_SENTENCES,
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

  it('never exceeds MAX_TOTAL_OUTPUT_TOKENS even with a huge configured ceiling', () => {
    expect(computeMaxOutputTokens(50, 1_000_000, true)).toBe(MAX_TOTAL_OUTPUT_TOKENS);
  });

  it('detailed mode (v2, core_pattern added) still fits one sentence comfortably under the ceiling', () => {
    // MAX_DETAILED_SENTENCES=1 is a hard server-side limit -- detailed
    // mode never has to multiply its larger per-item estimate across a
    // chunk, which is what makes raising DETAILED_TOKENS_PER_ITEM_ESTIMATE
    // for the new core_pattern field safe without reintroducing truncation.
    const tokens = computeMaxOutputTokens(MAX_DETAILED_SENTENCES, 4000, true);
    expect(tokens).toBeGreaterThan(2000); // raised from v1's ~2000 ceiling
    expect(tokens).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_TOKENS);
  });
});
