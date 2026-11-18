import { useState, type ReactNode } from 'react';
import type { ReviewStateRow, DbRating } from '@/lib/fsrs';
import { scheduleReview } from '@/lib/fsrs';
import { confirmReviewGrade } from '@/features/review/confirmReviewGrade';
import { correctAnswer, type WritingMode } from '@/features/today/writingPracticeClient';
import { RatingButtons } from '@/features/review/cards/RatingButtons';

export interface WritingCardShellProps {
  promptHeader: ReactNode;
  expressionId: string;
  reviewStateId: string;
  reviewState: ReviewStateRow;
  mode: WritingMode;
  exerciseId: string | null;
  grammarTags: string[];
  targetGrammar?: string | null;
  /** Renders the answer-input control (textarea, or a mic+textarea for speaking). Receives the current value + setter. */
  renderInput: (value: string, setValue: (v: string) => void) => ReactNode;
  onComplete: () => void;
}

/**
 * Shared submit -> AI correction -> model answer/explanation -> grade
 * flow for all 4 writing/speaking card types -- they differ only in
 * promptHeader/renderInput, not in this plumbing. Failed corrections
 * never clear the user's drafted answer (kept in this component's own
 * state until a successful response arrives), so a retry never loses
 * what they typed.
 */
export function WritingCardShell({
  promptHeader,
  expressionId,
  reviewStateId,
  reviewState,
  mode,
  exerciseId,
  grammarTags,
  targetGrammar,
  renderInput,
  onComplete,
}: WritingCardShellProps) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correction, setCorrection] = useState<Awaited<ReturnType<typeof correctAnswer>>['correction'] | null>(null);
  const [suggestedRating, setSuggestedRating] = useState<DbRating | null>(null);
  const [grading, setGrading] = useState(false);

  async function handleSubmit() {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const outcome = await correctAnswer({ exerciseId, expressionId, mode, grammarTags, userAnswerFr: answer, targetGrammar });
    setSubmitting(false);
    if (outcome.status === 'failed') {
      setError(outcome.error ?? 'unknown_error');
      return; // answer stays in state -- nothing lost, retry button just re-submits
    }
    setCorrection(outcome.correction ?? null);
    setSuggestedRating(outcome.aiSuggestedRating ?? null);
  }

  async function handleRate(rating: DbRating) {
    if (grading) return;
    setGrading(true);
    const nextState = scheduleReview(reviewState, rating);
    await confirmReviewGrade(crypto.randomUUID(), {
      reviewStateId,
      expressionId,
      rating,
      attemptType: 'writing',
      mode,
      newReviewState: nextState,
      exerciseId,
      responseText: answer,
      aiSuggestedRating: suggestedRating,
      aiFeedback: correction as unknown as Record<string, unknown>,
      grammarTags: [...new Set([...grammarTags, ...(correction?.grammar_error_tags ?? [])])],
    });
    setGrading(false);
    onComplete();
  }

  return (
    <div className="flex flex-col gap-4">
      {promptHeader}

      {!correction && (
        <div className="flex flex-col gap-3">
          {renderInput(answer, setAnswer)}
          <button
            onClick={handleSubmit}
            disabled={submitting || !answer.trim()}
            className="rounded-full bg-blue-600 py-4 text-lg font-semibold text-white disabled:opacity-40"
          >
            {submitting ? '교정 중...' : '제출'}
          </button>
          {error && (
            <p className="text-center text-sm text-red-500">
              교정 요청 실패: {error} — 답변은 그대로 남아 있어요, 다시 제출해 보세요.
            </p>
          )}
        </div>
      )}

      {correction && (
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-sm text-slate-400">내 답변</p>
            <p className="mt-1">{answer}</p>
          </div>

          {correction.corrected_fr && (
            <div className="rounded-2xl border border-green-200 p-4 dark:border-green-800">
              <p className="text-sm text-slate-400">모범 답안</p>
              <p className="mt-1 font-medium">{correction.corrected_fr}</p>
            </div>
          )}

          <p className="text-sm text-slate-600 dark:text-slate-300">{correction.explanation_ko}</p>

          {[...correction.grammar_errors, ...correction.vocab_preposition_errors, ...correction.tense_conjugation_errors].length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-amber-600">
              {[...correction.grammar_errors, ...correction.vocab_preposition_errors, ...correction.tense_conjugation_errors].map((e, i) => (
                <li key={i}>⚠ {e.text}: {e.note_ko}</li>
              ))}
            </ul>
          )}

          {correction.naturalness_notes_ko && <p className="text-xs text-slate-400">{correction.naturalness_notes_ko}</p>}

          <RatingButtons onRate={handleRate} suggestedRating={suggestedRating} />
        </div>
      )}
    </div>
  );
}
