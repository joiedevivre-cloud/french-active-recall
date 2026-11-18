import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { ReviewStateRow } from '@/lib/fsrs';
import { enqueueForReview } from '@/features/capture/addExpression';
import { generateExercise, type GeneratedExercise } from '@/features/today/writingPracticeClient';
import { KoreanPromptCard } from '@/features/review/cards/KoreanPromptCard';
import { grammarTagFromPattern, koGlossFor } from '@/lib/grammarTerms';

/**
 * "이 문법으로 문장 만들기": practice ONE construction of a saved expression.
 *
 * 1. AI gives a NEW Korean situation that needs exactly this construction
 *    (writing-practice generate, mode korean_prompt, targetPattern).
 * 2. Learner writes French.
 * 3. AI checks meaning + grammar + whether the target construction was used
 *    (writing-practice correct, targetGrammar).
 * 4. The construction's grammar_skills row records the hit/miss
 *    (grammarTagFromPattern) -- a miss raises it in the daily queue's
 *    weak-grammar priority.
 * 5. The learner's rating updates the expression's FSRS card through the
 *    same confirm_review_grade path as /today (WritingCardShell).
 */
export default function GrammarPracticePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const pattern = searchParams.get('pattern') ?? '';
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [exercise, setExercise] = useState<GeneratedExercise | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { data: reviewRow } = useQuery({
    queryKey: ['grammar-practice-review-state', id],
    enabled: !!user && !!id,
    queryFn: async () => {
      // A practiced expression must have an FSRS card to grade -- create it
      // if missing (same idempotent upsert every save path uses).
      await enqueueForReview(user!.id, id!);
      const { data, error: qError } = await supabase
        .from('review_states')
        .select('id, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_reviewed_at')
        .eq('user_id', user!.id)
        .eq('expression_id', id!)
        .single();
      if (qError) throw qError;
      return data;
    },
  });

  async function loadExercise(forceNew: boolean) {
    if (!id || !pattern) return;
    setGenerating(true);
    setError(null);
    setDone(false);
    const outcome = await generateExercise(id, 'korean_prompt', {
      grammarTags: [grammarTagFromPattern(pattern)],
      targetPattern: pattern,
      forceNew,
    });
    setGenerating(false);
    if (outcome.status === 'failed' || !outcome.exercise) {
      setError(outcome.error ?? 'unknown_error');
      return;
    }
    setExercise(outcome.exercise);
  }

  useEffect(() => {
    void loadExercise(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pattern]);

  const reviewState: ReviewStateRow | null = reviewRow
    ? {
        due_at: reviewRow.due_at,
        stability: reviewRow.stability,
        difficulty: reviewRow.difficulty,
        elapsed_days: reviewRow.elapsed_days,
        scheduled_days: reviewRow.scheduled_days,
        reps: reviewRow.reps,
        lapses: reviewRow.lapses,
        state: reviewRow.state,
        last_reviewed_at: reviewRow.last_reviewed_at,
      }
    : null;

  return (
    <div className="flex flex-col gap-4 p-5">
      <button onClick={() => navigate(-1)} className="self-start text-sm text-slate-400">
        ← 뒤로
      </button>

      <div className="rounded-2xl border border-blue-200 p-4 dark:border-blue-800">
        <p className="text-xs text-slate-400">Construction grammaticale · 이 문법으로 문장 만들기</p>
        <p className="mt-1 font-semibold italic">{pattern || '(문법 없음)'}</p>
        {koGlossFor(pattern) && <p className="text-xs text-slate-500">{koGlossFor(pattern)}</p>}
      </div>

      {!pattern && <p className="text-sm text-red-500">연습할 문법이 지정되지 않았습니다.</p>}
      {generating && <p className="text-sm text-slate-400">AI가 새 상황을 만드는 중...</p>}
      {error && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-500">문제 생성 실패: {error}</p>
          <button onClick={() => loadExercise(false)} className="rounded-full border border-slate-300 py-2 text-sm dark:border-slate-700">
            다시 시도
          </button>
        </div>
      )}

      {exercise && reviewRow && reviewState && !done && (
        <KoreanPromptCard
          key={exercise.id}
          expressionId={id!}
          reviewStateId={reviewRow.id}
          reviewState={reviewState}
          exercise={exercise}
          onComplete={() => {
            setDone(true);
            queryClient.invalidateQueries({ queryKey: ['grammar-practice-review-state', id] });
          }}
        />
      )}

      {done && (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-slate-500">기록했어요. 틀린 문법은 복습 우선순위에 반영됩니다.</p>
          <button
            onClick={() => loadExercise(true)}
            disabled={generating}
            className="rounded-full bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            새 상황으로 한 번 더
          </button>
          <button onClick={() => navigate(`/expression/${id}`)} className="rounded-full border border-slate-300 py-3 text-sm dark:border-slate-700">
            표현으로 돌아가기
          </button>
        </div>
      )}
    </div>
  );
}
