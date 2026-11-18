import { describe, expect, it } from 'vitest';
import {
  shouldSkipAnalysis,
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldRetryAfterSchemaFailure,
  normalizePattern,
  findMergeTargetUsageId,
  shouldPreserveField,
} from '../../../supabase/functions/_shared/lemmaMatching';

// This is the SAME file analyze-lemma (Deno) imports -- testing it here
// exercises the real decision logic, not a reimplementation that could
// drift from what the Edge Function actually does.

describe('shouldSkipAnalysis (cache hit -> 0 AI calls)', () => {
  it('skips when analysis already exists and force is not set', () => {
    expect(shouldSkipAnalysis(true, false)).toBe(true);
  });
  it('does not skip when force is set, even if analysis exists', () => {
    expect(shouldSkipAnalysis(true, true)).toBe(false);
  });
  it('does not skip when no analysis exists yet', () => {
    expect(shouldSkipAnalysis(false, false)).toBe(false);
  });
});

describe('resolveExistingUsageId (reuse only on exact pattern match)', () => {
  const usages = [
    { id: 'u1', pattern: 'mettre en marche' },
    { id: 'u2', pattern: 'se mettre à + infinitif' },
    { id: 'u3', pattern: null },
  ];
  it('reuses the id when it belongs to this lemma and the pattern matches', () => {
    expect(resolveExistingUsageId('u2', 'se mettre à + infinitif', usages)).toBe('u2');
  });
  it("rejects a hallucinated/stale id not in this lemma's usages", () => {
    expect(resolveExistingUsageId('u-does-not-exist', 'se mettre à + infinitif', usages)).toBeNull();
  });
  it('returns null when the AI suggested none', () => {
    expect(resolveExistingUsageId(null, 'mettre en marche', usages)).toBeNull();
  });
  it('REGRESSION (mettre): rejects a real, owned id whose pattern differs from the recognized one', () => {
    // "Je me suis mise à chercher..." must NOT land in the "mettre en marche" (기기를 켜다) usage.
    expect(resolveExistingUsageId('u1', 'se mettre à + infinitif', usages)).toBeNull();
  });
  it('matches across case/accent/whitespace differences', () => {
    expect(resolveExistingUsageId('u2', '  Se Mettre A  +  Infinitif ', usages)).toBe('u2');
  });
  it('never reuses a usage with no stored pattern', () => {
    expect(resolveExistingUsageId('u3', 'mettre en marche', usages)).toBeNull();
  });
});

describe('normalizePattern', () => {
  it('lowercases, strips accents, collapses whitespace/punctuation, keeps +', () => {
    expect(normalizePattern('Se  Mettre À + Infinitif')).toBe('se mettre a + infinitif');
    expect(normalizePattern("mettre (qqch) à jour")).toBe('mettre qqch a jour');
  });
  it('keeps genuinely different constructions distinct', () => {
    expect(normalizePattern('mettre à jour')).not.toBe(normalizePattern('mettre en marche'));
  });
});

describe('findMergeTargetUsageId (seed_dictionary merges, never replaces)', () => {
  const existing = [
    { id: 'learned1', pattern: 'se mettre à + infinitif' },
    { id: 'nopattern', pattern: null },
  ];
  it('merges a dictionary sense into an existing usage with the same pattern', () => {
    expect(findMergeTargetUsageId('Se mettre à + infinitif', existing)).toBe('learned1');
  });
  it('returns null (= add a new usage) when no existing pattern matches', () => {
    expect(findMergeTargetUsageId('mettre du temps à + infinitif', existing)).toBeNull();
  });
});

describe('shouldPreserveField (per-field user-edit protection)', () => {
  it('preserves fields the user hand-edited', () => {
    expect(shouldPreserveField(['meaning_ko', 'grammar_explanation_ko'], 'meaning_ko')).toBe(true);
  });
  it('allows AI updates to fields the user did not edit', () => {
    expect(shouldPreserveField(['meaning_ko'], 'pattern')).toBe(false);
  });
  it('treats null/undefined as nothing edited', () => {
    expect(shouldPreserveField(null, 'meaning_ko')).toBe(false);
    expect(shouldPreserveField(undefined, 'meaning_ko')).toBe(false);
  });
});

describe('shouldCreateNewUsage', () => {
  it('creates a new usage only when nothing resolved', () => {
    expect(shouldCreateNewUsage(null)).toBe(true);
    expect(shouldCreateNewUsage('u1')).toBe(false);
  });
});

describe('shouldPreserveUserAssignedUsage (user-edit protection)', () => {
  it('preserves when the user manually assigned this usage', () => {
    expect(shouldPreserveUserAssignedUsage({ usage_user_assigned: true })).toBe(true);
  });
  it('does not preserve when no prior row exists', () => {
    expect(shouldPreserveUserAssignedUsage(null)).toBe(false);
  });
  it('does not preserve an AI-assigned (not user-assigned) row', () => {
    expect(shouldPreserveUserAssignedUsage({ usage_user_assigned: false })).toBe(false);
  });
});

describe('shouldPreserveUserEditedLabel', () => {
  it('preserves a hand-edited label', () => {
    expect(shouldPreserveUserEditedLabel({ label_user_edited: true })).toBe(true);
  });
  it('allows overwrite when label was never hand-edited', () => {
    expect(shouldPreserveUserEditedLabel({ label_user_edited: false })).toBe(false);
    expect(shouldPreserveUserEditedLabel(null)).toBe(false);
  });
});

describe('shouldRetryAfterSchemaFailure (1 retry max)', () => {
  it('retries once after the first failed attempt', () => {
    expect(shouldRetryAfterSchemaFailure(0, 1)).toBe(true);
  });
  it('stops after reaching maxAttempts', () => {
    expect(shouldRetryAfterSchemaFailure(1, 1)).toBe(false);
  });
});
