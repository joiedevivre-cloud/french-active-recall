import { describe, expect, it } from 'vitest';
import { buildTodayQueue, type ReviewStateInput } from '@/features/today/buildTodayQueue';

const NOW = new Date('2026-06-15T00:00:00Z');

function row(overrides: Partial<ReviewStateInput>): ReviewStateInput {
  return {
    reviewStateId: 'rs',
    expressionId: 'e',
    dueAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    state: 'review',
    stability: 10,
    grammarTags: [],
    ...overrides,
  };
}

const defaultLimits = { dailyReviewLimit: 15, dailyNewLimit: 3, dailyWritingTarget: 5, dailySpeakingTarget: 3 };

describe('buildTodayQueue priority order', () => {
  it('orders more-overdue cards before less-overdue ones', () => {
    const veryOverdue = row({ reviewStateId: 'a', expressionId: 'e-a', dueAt: '2026-06-01T00:00:00Z' });
    const slightlyOverdue = row({ reviewStateId: 'b', expressionId: 'e-b', dueAt: '2026-06-14T00:00:00Z' });
    const result = buildTodayQueue({
      reviewStates: [slightlyOverdue, veryOverdue],
      recentlyWrong: [],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots.map((s) => s.reviewStateId)).toEqual(['a', 'b']);
  });

  it('within the same overdue-day bucket, a recently-wrong card ranks before one that was not', () => {
    const wrong = row({ reviewStateId: 'a', expressionId: 'e-a', dueAt: '2026-06-14T00:00:00Z' });
    const notWrong = row({ reviewStateId: 'b', expressionId: 'e-b', dueAt: '2026-06-14T00:00:00Z' });
    const result = buildTodayQueue({
      reviewStates: [notWrong, wrong],
      recentlyWrong: [{ expressionId: 'e-a' }],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots.map((s) => s.reviewStateId)).toEqual(['a', 'b']);
  });

  it('within the same overdue-day and wrong-status, lower stability ranks first', () => {
    const lowStability = row({ reviewStateId: 'a', expressionId: 'e-a', dueAt: '2026-06-14T00:00:00Z', stability: 2 });
    const highStability = row({ reviewStateId: 'b', expressionId: 'e-b', dueAt: '2026-06-14T00:00:00Z', stability: 50 });
    const result = buildTodayQueue({
      reviewStates: [highStability, lowStability],
      recentlyWrong: [],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots.map((s) => s.reviewStateId)).toEqual(['a', 'b']);
  });

  it('places new cards after all due cards, oldest first', () => {
    const due = row({ reviewStateId: 'due', expressionId: 'e-due', dueAt: '2026-06-14T00:00:00Z' });
    const newer = row({ reviewStateId: 'new2', expressionId: 'e-new2', state: 'new', createdAt: '2026-06-10T00:00:00Z' });
    const older = row({ reviewStateId: 'new1', expressionId: 'e-new1', state: 'new', createdAt: '2026-06-05T00:00:00Z' });
    const result = buildTodayQueue({
      reviewStates: [newer, due, older],
      recentlyWrong: [],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots.map((s) => s.reviewStateId)).toEqual(['due', 'new1', 'new2']);
  });
});

describe('buildTodayQueue caps (never force the whole backlog)', () => {
  it('caps due cards at dailyReviewLimit and reports how many were dropped', () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ reviewStateId: `r${i}`, expressionId: `e${i}`, dueAt: '2026-06-14T00:00:00Z' }));
    const result = buildTodayQueue({
      reviewStates: many,
      recentlyWrong: [],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyReviewLimit: 5, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots).toHaveLength(5);
    expect(result.droppedOverdueCount).toBe(15);
  });

  it('caps new cards at dailyNewLimit independently of dailyReviewLimit', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ reviewStateId: `n${i}`, expressionId: `e${i}`, state: 'new', createdAt: `2026-06-0${(i % 9) + 1}T00:00:00Z` }));
    const result = buildTodayQueue({
      reviewStates: many,
      recentlyWrong: [],
      grammarSkills: [],
      limits: { ...defaultLimits, dailyNewLimit: 2, dailyWritingTarget: 0, dailySpeakingTarget: 0 },
      now: NOW,
    });
    expect(result.slots).toHaveLength(2);
  });
});

describe('buildTodayQueue writing/speaking slot carve-out (no double-counting)', () => {
  it('carves writing/speaking slots OUT of the capped pool rather than adding extra items', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ reviewStateId: `r${i}`, expressionId: `e${i}`, dueAt: '2026-06-14T00:00:00Z' }));
    const result = buildTodayQueue({
      reviewStates: many,
      recentlyWrong: [],
      grammarSkills: [],
      limits: { dailyReviewLimit: 10, dailyNewLimit: 0, dailyWritingTarget: 3, dailySpeakingTarget: 2 },
      now: NOW,
    });
    // Same 10 cards total, just split across types -- never 10 review + extra writing/speaking.
    expect(result.slots).toHaveLength(10);
    const ids = result.slots.map((s) => s.reviewStateId);
    expect(new Set(ids).size).toBe(10); // every card appears exactly once
    expect(result.slots.filter((s) => s.type === 'writing')).toHaveLength(3);
    expect(result.slots.filter((s) => s.type === 'speaking')).toHaveLength(2);
    expect(result.slots.filter((s) => s.type === 'review')).toHaveLength(5);
  });

  it('prefers cards whose grammarTags overlap the weakest grammar_skills tag for writing slots', () => {
    const weakTagCard = row({ reviewStateId: 'a', expressionId: 'e-a', dueAt: '2026-06-14T00:00:00Z', grammarTags: ['subjonctif'] });
    const noTagCard = row({ reviewStateId: 'b', expressionId: 'e-b', dueAt: '2026-06-13T00:00:00Z', grammarTags: [] });
    const result = buildTodayQueue({
      reviewStates: [weakTagCard, noTagCard],
      recentlyWrong: [],
      grammarSkills: [{ tag: 'subjonctif', totalAttempts: 10, correctAttempts: 2 }],
      limits: { dailyReviewLimit: 10, dailyNewLimit: 0, dailyWritingTarget: 1, dailySpeakingTarget: 0 },
      now: NOW,
    });
    const writing = result.slots.find((s) => s.type === 'writing');
    // 'b' is more overdue (would normally rank first for review), but 'a' carries the
    // weak grammar tag -- the writing slot should still prefer it.
    expect(writing?.reviewStateId).toBe('a');
  });

  it('falls back to the front of the pool when no grammar tag overlap exists', () => {
    const many = Array.from({ length: 3 }, (_, i) => row({ reviewStateId: `r${i}`, expressionId: `e${i}`, dueAt: `2026-06-${10 + i}T00:00:00Z` }));
    const result = buildTodayQueue({
      reviewStates: many,
      recentlyWrong: [],
      grammarSkills: [],
      limits: { dailyReviewLimit: 10, dailyNewLimit: 0, dailyWritingTarget: 1, dailySpeakingTarget: 0 },
      now: NOW,
    });
    // Most overdue (r0, due 06-10) should be picked for the one writing slot.
    expect(result.slots.find((s) => s.type === 'writing')?.reviewStateId).toBe('r0');
  });
});
