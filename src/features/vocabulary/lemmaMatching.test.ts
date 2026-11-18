import { describe, expect, it } from 'vitest';
import {
  shouldSkipAnalysis,
  resolveExistingUsageId,
  shouldCreateNewUsage,
  shouldPreserveUserAssignedUsage,
  shouldPreserveUserEditedLabel,
  shouldRetryAfterSchemaFailure,
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

describe('resolveExistingUsageId (same label -> reuse, no duplicate)', () => {
  const usages = [{ id: 'u1' }, { id: 'u2' }];
  it('reuses the id when it belongs to this lemma', () => {
    expect(resolveExistingUsageId('u1', usages)).toBe('u1');
  });
  it('rejects a hallucinated/stale id not in this lemma\'s usages', () => {
    expect(resolveExistingUsageId('u-does-not-exist', usages)).toBeNull();
  });
  it('returns null when the AI suggested none', () => {
    expect(resolveExistingUsageId(null, usages)).toBeNull();
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
