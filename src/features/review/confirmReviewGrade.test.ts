import { describe, expect, it, vi, beforeEach } from 'vitest';
import { confirmReviewGrade } from '@/features/review/confirmReviewGrade';
import type { ReviewStateRow } from '@/lib/fsrs';

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

beforeEach(() => {
  rpcMock.mockReset();
});

const fakeNewState: ReviewStateRow = {
  due_at: '2026-02-01T00:00:00.000Z',
  stability: 5,
  difficulty: 3,
  elapsed_days: 0,
  scheduled_days: 5,
  reps: 1,
  lapses: 0,
  state: 'learning',
  last_reviewed_at: '2026-01-01T00:00:00.000Z',
  last_retrievability: 0.9,
};

describe('confirmReviewGrade', () => {
  it('calls the confirm_review_grade RPC with the given idempotency client id', async () => {
    rpcMock.mockResolvedValue({ data: [{ attempt_id: 'a1', already_applied: false }], error: null });

    const result = await confirmReviewGrade('client-123', {
      reviewStateId: 'rs1',
      expressionId: 'e1',
      rating: 'good',
      attemptType: 'meaning_recall',
      newReviewState: fakeNewState,
    });

    expect(rpcMock).toHaveBeenCalledWith('confirm_review_grade', expect.objectContaining({ p_client_id: 'client-123', p_rating: 'good' }));
    expect(result).toEqual({ attemptId: 'a1', alreadyApplied: false });
  });

  it('surfaces already_applied=true on a retried/duplicate client id (idempotent no-op)', async () => {
    rpcMock.mockResolvedValue({ data: [{ attempt_id: 'a1', already_applied: true }], error: null });

    const result = await confirmReviewGrade('client-123', {
      reviewStateId: 'rs1',
      expressionId: 'e1',
      rating: 'good',
      attemptType: 'meaning_recall',
      newReviewState: fakeNewState,
    });

    expect(result.alreadyApplied).toBe(true);
  });

  it('throws on an RPC error instead of silently swallowing it', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'review_state_not_found_or_not_owned' } });

    await expect(
      confirmReviewGrade('client-123', {
        reviewStateId: 'rs1',
        expressionId: 'e1',
        rating: 'good',
        attemptType: 'meaning_recall',
        newReviewState: fakeNewState,
      })
    ).rejects.toBeTruthy();
  });

  it('defaults mode/exerciseId/grammarTags/aiFeedback when omitted', async () => {
    rpcMock.mockResolvedValue({ data: [{ attempt_id: 'a1', already_applied: false }], error: null });

    await confirmReviewGrade('client-123', {
      reviewStateId: 'rs1',
      expressionId: 'e1',
      rating: 'easy',
      attemptType: 'fill_blank',
      newReviewState: fakeNewState,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      'confirm_review_grade',
      expect.objectContaining({ p_mode: 'meaning_recall', p_exercise_id: null, p_grammar_tags: [], p_ai_feedback: null })
    );
  });
});
