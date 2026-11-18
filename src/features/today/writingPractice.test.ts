import { describe, expect, it } from 'vitest';
import {
  pickCachedExercise,
  shouldSkipGeneration,
  sanitizeGrammarTags,
  suggestRatingFromCorrection,
} from '../../../supabase/functions/_shared/writingPractice';

// Same file the writing-practice Edge Function (Deno) imports -- testing
// it here exercises the real decision logic, not a parallel reimplementation.

describe('pickCachedExercise (cache generated exercises, avoid needless regeneration)', () => {
  it('picks the first unused (timesUsed=0) candidate', () => {
    const candidates = [{ id: 'a', timesUsed: 1 }, { id: 'b', timesUsed: 0 }, { id: 'c', timesUsed: 0 }];
    expect(pickCachedExercise(candidates, false)).toEqual({ id: 'b', timesUsed: 0 });
  });

  it('returns null (cache miss -> generate a fresh variant) when every candidate has been used', () => {
    const candidates = [{ id: 'a', timesUsed: 2 }, { id: 'b', timesUsed: 1 }];
    expect(pickCachedExercise(candidates, false)).toBeNull();
  });

  it('returns null when forceNew is set, even if an unused candidate exists', () => {
    const candidates = [{ id: 'a', timesUsed: 0 }];
    expect(pickCachedExercise(candidates, true)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(pickCachedExercise([], false)).toBeNull();
  });
});

describe('shouldSkipGeneration', () => {
  it('skips AI generation (0 calls) when a cached exercise was found', () => {
    expect(shouldSkipGeneration({ id: 'a', timesUsed: 0 })).toBe(true);
  });
  it('does not skip when there is no cached exercise', () => {
    expect(shouldSkipGeneration(null)).toBe(false);
  });
});

describe('sanitizeGrammarTags', () => {
  it('trims, dedupes, and drops empty/non-string entries', () => {
    expect(sanitizeGrammarTags(['subjonctif', ' subjonctif ', '', 42, null, 'imparfait'])).toEqual(['subjonctif', 'imparfait']);
  });
  it('returns an empty array for a non-array input', () => {
    expect(sanitizeGrammarTags(undefined)).toEqual([]);
    expect(sanitizeGrammarTags('subjonctif')).toEqual([]);
  });
});

describe('suggestRatingFromCorrection', () => {
  it('suggests again when meaning was not conveyed, regardless of other errors', () => {
    expect(
      suggestRatingFromCorrection({ meaningOk: false, hasGrammarErrors: false, hasVocabOrPrepositionErrors: false, hasTenseOrConjugationErrors: false })
    ).toBe('again');
  });
  it('suggests hard when meaning is ok but any error type is present', () => {
    expect(
      suggestRatingFromCorrection({ meaningOk: true, hasGrammarErrors: true, hasVocabOrPrepositionErrors: false, hasTenseOrConjugationErrors: false })
    ).toBe('hard');
  });
  it('never auto-suggests easy -- a clean answer suggests good at most', () => {
    expect(
      suggestRatingFromCorrection({ meaningOk: true, hasGrammarErrors: false, hasVocabOrPrepositionErrors: false, hasTenseOrConjugationErrors: false })
    ).toBe('good');
  });
});
