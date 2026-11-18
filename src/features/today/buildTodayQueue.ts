// Pure queue-composition logic for the "오늘의 학습" screen. Deliberately
// has no Supabase/network code -- the caller fetches rows and passes
// plain data in, so this is fully unit-testable (see buildTodayQueue.test.ts).

export type ReviewCardState = 'new' | 'learning' | 'review' | 'relearning';

export interface ReviewStateInput {
  reviewStateId: string;
  expressionId: string;
  dueAt: string; // ISO
  createdAt: string; // ISO
  state: ReviewCardState;
  stability: number;
  grammarTags: string[]; // tags associated with this expression's writing history, if any
}

export interface RecentlyWrongInput {
  expressionId: string;
}

export interface GrammarSkillInput {
  tag: string;
  totalAttempts: number;
  correctAttempts: number;
}

export interface DailyLimits {
  dailyReviewLimit: number;
  dailyNewLimit: number;
  dailyWritingTarget: number;
  dailySpeakingTarget: number;
}

export type QueueSlotType = 'review' | 'writing' | 'speaking';

export interface TodayQueueSlot {
  type: QueueSlotType;
  reviewStateId: string;
  expressionId: string;
}

export interface TodayQueue {
  slots: TodayQueueSlot[];
  droppedOverdueCount: number; // overdue/due cards that didn't fit today's cap -- never force the whole backlog
}

function daysOverdue(dueAt: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(dueAt).getTime()) / 86_400_000);
}

/**
 * Lower pass rate first (weakest grammar first); a tag with 0 attempts
 * is treated as weakest of all (nothing proven yet), so brand-new tags
 * still get a chance to be practiced rather than being ranked as if
 * already mastered.
 */
function weakestTagsFirst(skills: GrammarSkillInput[]): string[] {
  return [...skills]
    .sort((a, b) => {
      const rateA = a.totalAttempts === 0 ? -1 : a.correctAttempts / a.totalAttempts;
      const rateB = b.totalAttempts === 0 ? -1 : b.correctAttempts / b.totalAttempts;
      return rateA - rateB;
    })
    .map((s) => s.tag);
}

/**
 * Builds today's queue: overdue (ranked by how overdue, then recently-wrong,
 * then lowest stability) > new, each capped by its own daily limit so a
 * large backlog is never forced into one day -- the rest simply remains
 * due for tomorrow's run of this same function. Writing/speaking slots
 * are carved OUT of this same capped set (not additional items), so the
 * same card is never counted for review AND writing/speaking in one day.
 */
export function buildTodayQueue(input: {
  reviewStates: ReviewStateInput[];
  recentlyWrong: RecentlyWrongInput[];
  grammarSkills: GrammarSkillInput[];
  limits: DailyLimits;
  now?: Date;
}): TodayQueue {
  const now = input.now ?? new Date();
  const recentlyWrongIds = new Set(input.recentlyWrong.map((r) => r.expressionId));

  const dueCandidates = input.reviewStates.filter((rs) => rs.state !== 'new');
  const rankedDue = [...dueCandidates].sort((a, b) => {
    const overdueDiff = daysOverdue(b.dueAt, now) - daysOverdue(a.dueAt, now);
    if (overdueDiff !== 0) return overdueDiff;
    const wrongDiff = Number(recentlyWrongIds.has(b.expressionId)) - Number(recentlyWrongIds.has(a.expressionId));
    if (wrongDiff !== 0) return wrongDiff;
    return a.stability - b.stability;
  });

  const newCandidates = input.reviewStates
    .filter((rs) => rs.state === 'new')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const cappedDue = rankedDue.slice(0, input.limits.dailyReviewLimit);
  const cappedNew = newCandidates.slice(0, input.limits.dailyNewLimit);
  const droppedOverdueCount = Math.max(0, rankedDue.length - cappedDue.length);

  const pool = [...cappedDue, ...cappedNew];
  const remaining = new Set(pool.map((p) => p.reviewStateId));
  const weakTags = weakestTagsFirst(input.grammarSkills);

  function takeSlots(count: number, type: QueueSlotType): TodayQueueSlot[] {
    const picked: TodayQueueSlot[] = [];
    // Prefer items whose grammarTags overlap a weak tag, weakest first.
    for (const tag of weakTags) {
      if (picked.length >= count) break;
      const match = pool.find((p) => remaining.has(p.reviewStateId) && p.grammarTags.includes(tag));
      if (match) {
        remaining.delete(match.reviewStateId);
        picked.push({ type, reviewStateId: match.reviewStateId, expressionId: match.expressionId });
      }
    }
    // Fall back to the front of the remaining pool (highest review priority first).
    for (const item of pool) {
      if (picked.length >= count) break;
      if (!remaining.has(item.reviewStateId)) continue;
      remaining.delete(item.reviewStateId);
      picked.push({ type, reviewStateId: item.reviewStateId, expressionId: item.expressionId });
    }
    return picked;
  }

  const writingSlots = takeSlots(input.limits.dailyWritingTarget, 'writing');
  const speakingSlots = takeSlots(input.limits.dailySpeakingTarget, 'speaking');
  const reviewSlots = pool.filter((p) => remaining.has(p.reviewStateId)).map((p) => ({ type: 'review' as const, reviewStateId: p.reviewStateId, expressionId: p.expressionId }));

  return { slots: [...reviewSlots, ...writingSlots, ...speakingSlots], droppedOverdueCount };
}
