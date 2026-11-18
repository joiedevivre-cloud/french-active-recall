import { supabase } from '@/lib/supabase';
import type { DbRating, ReviewStateRow } from '@/lib/fsrs';

export interface ConfirmReviewGradeInput {
  reviewStateId: string;
  expressionId: string;
  rating: DbRating;
  attemptType: string;
  mode?: string;
  newReviewState: ReviewStateRow;
  exerciseId?: string | null;
  responseText?: string | null;
  responseTimeMs?: number | null;
  hintUsed?: boolean;
  aiSuggestedRating?: DbRating | null;
  aiFeedback?: Record<string, unknown> | null;
  grammarTags?: string[];
}

export interface ConfirmReviewGradeResult {
  attemptId: string;
  alreadyApplied: boolean;
}

/**
 * Atomically persists one confirmed FSRS rating: updates review_states
 * and inserts review_attempts in a single RPC call (public.confirm_review_grade,
 * migration 0015) instead of the two separate, non-transactional writes
 * TodayReview.tsx used to make. FSRS math itself still runs entirely
 * client-side (scheduleReview in src/lib/fsrs.ts, unchanged) -- this only
 * persists what the caller already computed.
 *
 * Idempotent via clientId: calling this twice with the SAME clientId (e.g.
 * a retried network request) returns the already-applied attempt instead
 * of double-counting the FSRS rep. The caller must generate one clientId
 * per grade-confirm action (not per render) and reuse it across retries.
 */
export async function confirmReviewGrade(
  clientId: string,
  input: ConfirmReviewGradeInput
): Promise<ConfirmReviewGradeResult> {
  const { data, error } = await supabase.rpc('confirm_review_grade', {
    p_client_id: clientId,
    p_review_state_id: input.reviewStateId,
    p_expression_id: input.expressionId,
    p_rating: input.rating,
    p_attempt_type: input.attemptType,
    p_mode: input.mode ?? 'meaning_recall',
    p_new_review_state: input.newReviewState,
    p_exercise_id: input.exerciseId ?? null,
    p_response_text: input.responseText ?? null,
    p_response_time_ms: input.responseTimeMs ?? null,
    p_hint_used: input.hintUsed ?? false,
    p_ai_suggested_rating: input.aiSuggestedRating ?? null,
    p_ai_feedback: input.aiFeedback ?? null,
    p_grammar_tags: input.grammarTags ?? [],
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { attemptId: row.attempt_id, alreadyApplied: row.already_applied };
}
