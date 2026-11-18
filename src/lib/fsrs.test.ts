import { describe, expect, it } from 'vitest';
import { scheduleReview, previewIntervals, estimateCurrentRetrievability, type ReviewStateRow } from '@/lib/fsrs';

function newCardRow(): ReviewStateRow {
  return {
    due_at: new Date().toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
    last_reviewed_at: null,
  };
}

// These exercise the real ts-fsrs library through the existing wrapper --
// not a reimplementation of FSRS math, just confirming the wrapper calls
// it correctly and the new optional params/fields behave as documented.

describe('scheduleReview (real ts-fsrs behavior)', () => {
  it('a brand-new card rated "good" advances to learning with 1 rep', () => {
    const next = scheduleReview(newCardRow(), 'good', new Date('2026-01-01T00:00:00Z'));
    expect(next.reps).toBe(1);
    expect(next.state).toBe('learning');
    expect(next.lapses).toBe(0);
  });

  it('a mature "review" card rated "again" lapses and goes to relearning', () => {
    const matureCard: ReviewStateRow = {
      due_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      stability: 20,
      difficulty: 5,
      elapsed_days: 10,
      scheduled_days: 10,
      reps: 5,
      lapses: 0,
      state: 'review',
      last_reviewed_at: new Date('2025-12-22T00:00:00Z').toISOString(),
    };
    const next = scheduleReview(matureCard, 'again', new Date('2026-01-01T00:00:00Z'));
    expect(next.state).toBe('relearning');
    expect(next.lapses).toBe(1);
  });

  it('omitting requestRetention keeps the default 0.9 behavior (no requestRetention arg == explicit 0.9)', () => {
    const row = newCardRow();
    const now = new Date('2026-01-01T00:00:00Z');
    const withoutArg = scheduleReview(row, 'good', now);
    const withDefaultArg = scheduleReview(row, 'good', now, 0.9);
    expect(withoutArg).toEqual(withDefaultArg);
  });

  it('a lower desired_retention schedules a longer interval for the same rating', () => {
    const matureCard: ReviewStateRow = {
      due_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      stability: 20,
      difficulty: 5,
      elapsed_days: 10,
      scheduled_days: 10,
      reps: 5,
      lapses: 0,
      state: 'review',
      last_reviewed_at: new Date('2025-12-22T00:00:00Z').toISOString(),
    };
    const now = new Date('2026-01-01T00:00:00Z');
    const highRetention = scheduleReview(matureCard, 'good', now, 0.95);
    const lowRetention = scheduleReview(matureCard, 'good', now, 0.75);
    expect(lowRetention.scheduled_days).toBeGreaterThan(highRetention.scheduled_days);
  });

  it('attaches a last_retrievability snapshot in (0, 1] for a previously-reviewed card', () => {
    const matureCard: ReviewStateRow = {
      due_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      stability: 20,
      difficulty: 5,
      elapsed_days: 10,
      scheduled_days: 10,
      reps: 5,
      lapses: 0,
      state: 'review',
      last_reviewed_at: new Date('2025-12-22T00:00:00Z').toISOString(),
    };
    const next = scheduleReview(matureCard, 'good', new Date('2026-01-01T00:00:00Z'));
    expect(next.last_retrievability).not.toBeNull();
    expect(next.last_retrievability!).toBeGreaterThan(0);
    expect(next.last_retrievability!).toBeLessThanOrEqual(1);
  });
});

describe('previewIntervals', () => {
  it('returns all 4 rating previews, each with a due date not before now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const previews = previewIntervals(newCardRow(), now);
    for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
      expect(previews[rating].due.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });
});

describe('estimateCurrentRetrievability (live, not stored)', () => {
  it('returns null for a card never reviewed', () => {
    expect(estimateCurrentRetrievability(newCardRow())).toBeNull();
  });

  it('decreases as more time passes since the last review', () => {
    const row: ReviewStateRow = {
      due_at: new Date('2026-02-01T00:00:00Z').toISOString(),
      stability: 10,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 10,
      reps: 3,
      lapses: 0,
      state: 'review',
      last_reviewed_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
    const soon = estimateCurrentRetrievability(row, new Date('2026-01-02T00:00:00Z'))!;
    const later = estimateCurrentRetrievability(row, new Date('2026-01-20T00:00:00Z'))!;
    expect(later).toBeLessThan(soon);
  });
});
