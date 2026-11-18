import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import type { ReviewStateRow } from '@/lib/fsrs';
import { buildTodayQueue, type ReviewStateInput, type TodayQueueSlot } from '@/features/today/buildTodayQueue';
import { generateExercise, type GeneratedExercise, type WritingMode } from '@/features/today/writingPracticeClient';
import { confirmReviewGrade } from '@/features/review/confirmReviewGrade';
import { scheduleReview, type DbRating } from '@/lib/fsrs';
import { MeaningRecallCard } from '@/features/review/cards/MeaningRecallCard';
import { FillBlankCard } from '@/features/review/cards/FillBlankCard';
import { TransformCard } from '@/features/review/cards/TransformCard';
import { KoreanPromptCard } from '@/features/review/cards/KoreanPromptCard';
import { SituationalCard } from '@/features/review/cards/SituationalCard';
import { SpeakingCard } from '@/features/review/cards/SpeakingCard';

const RECENTLY_WRONG_WINDOW_DAYS = 14;

interface ExpressionRow {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
  expression_examples: { sentence_fr: string }[];
}

interface ReviewStateQueryRow {
  id: string;
  expression_id: string;
  due_at: string;
  created_at: string;
  state: 'new' | 'learning' | 'review' | 'relearning';
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  last_reviewed_at: string | null;
  expressions: ExpressionRow | ExpressionRow[];
}

function toExpression(row: ReviewStateQueryRow): ExpressionRow {
  return Array.isArray(row.expressions) ? row.expressions[0] : row.expressions;
}

function toReviewStateRow(row: ReviewStateQueryRow): ReviewStateRow {
  return {
    due_at: row.due_at,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_reviewed_at: row.last_reviewed_at,
  };
}

export default function TodayPractice() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [exercise, setExercise] = useState<GeneratedExercise | null>(null);
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [exerciseError, setExerciseError] = useState<string | null>(null);

  const { settings } = useSettings();

  const { data: reviewStateRows } = useQuery({
    queryKey: ['today-review-states', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_states')
        .select(
          `id, expression_id, due_at, created_at, state, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, last_reviewed_at,
           expressions!inner ( id, expression_fr, meaning_ko, deleted_at, expression_examples ( sentence_fr ) )`
        )
        .eq('user_id', user!.id)
        .is('expressions.deleted_at', null)
        .or(`due_at.lte.${new Date().toISOString()},state.eq.new`);
      if (error) throw error;
      return (data ?? []) as unknown as ReviewStateQueryRow[];
    },
  });

  const { data: recentlyWrong } = useQuery({
    queryKey: ['today-recently-wrong', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const since = new Date(Date.now() - RECENTLY_WRONG_WINDOW_DAYS * 86_400_000).toISOString();
      const { data } = await supabase.from('review_attempts').select('expression_id').eq('user_id', user!.id).eq('self_rating', 'again').gte('created_at', since);
      return data ?? [];
    },
  });

  const { data: grammarSkills } = useQuery({
    queryKey: ['today-grammar-skills', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('grammar_skills').select('tag, total_attempts, correct_attempts').eq('user_id', user!.id);
      return data ?? [];
    },
  });

  const ready = !!settings && !!reviewStateRows && !!recentlyWrong && !!grammarSkills;

  const queue = ready
    ? buildTodayQueue({
        reviewStates: (reviewStateRows ?? []).map(
          (row): ReviewStateInput => ({
            reviewStateId: row.id,
            expressionId: row.expression_id,
            dueAt: row.due_at,
            createdAt: row.created_at,
            state: row.state,
            stability: row.stability,
            grammarTags: [],
          })
        ),
        recentlyWrong: (recentlyWrong ?? []).map((r) => ({ expressionId: r.expression_id })),
        grammarSkills: (grammarSkills ?? []).map((g) => ({ tag: g.tag, totalAttempts: g.total_attempts, correctAttempts: g.correct_attempts })),
        limits: {
          dailyReviewLimit: settings!.daily_review_limit,
          dailyNewLimit: settings!.daily_new_limit,
          dailyWritingTarget: settings!.daily_writing_target,
          dailySpeakingTarget: settings!.daily_speaking_target,
        },
      })
    : null;

  const currentSlot: TodayQueueSlot | undefined = queue?.slots[index];
  const currentRow = currentSlot ? reviewStateRows?.find((r) => r.id === currentSlot.reviewStateId) : undefined;

  useEffect(() => {
    setExercise(null);
    setExerciseError(null);
    if (!currentSlot || currentSlot.type === 'review') return;

    let cancelled = false;
    setExerciseLoading(true);
    void generateExercise(currentSlot.expressionId, currentSlot.type as WritingMode).then((outcome) => {
      if (cancelled) return;
      setExerciseLoading(false);
      if (outcome.status === 'failed') {
        setExerciseError(outcome.error ?? 'unknown_error');
        return;
      }
      setExercise(outcome.exercise ?? null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlot?.reviewStateId, currentSlot?.type]);

  function advance() {
    setCompletedCount((c) => c + 1);
    setIndex((i) => i + 1);
  }

  async function handleReviewRate(rating: DbRating, hintUsed: boolean, responseTimeMs: number) {
    if (!currentRow) return;
    const nextState = scheduleReview(toReviewStateRow(currentRow), rating, new Date(), settings?.desired_retention);
    await confirmReviewGrade(crypto.randomUUID(), {
      reviewStateId: currentRow.id,
      expressionId: currentRow.expression_id,
      rating,
      attemptType: toExpression(currentRow).expression_examples?.[0] ? 'fill_blank' : 'meaning_recall',
      mode: 'meaning_recall',
      newReviewState: nextState,
      responseTimeMs,
      hintUsed,
    });
    advance();
  }

  if (!ready) {
    return <div className="p-5 text-sm text-slate-400">불러오는 중...</div>;
  }

  if (!currentSlot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
        <p className="text-lg font-semibold">오늘의 학습을 모두 마쳤어요</p>
        <p className="text-sm text-slate-400">완료 {completedCount}개</p>
        {queue && queue.droppedOverdueCount > 0 && (
          <p className="text-xs text-slate-400">아직 {queue.droppedOverdueCount}개가 더 기다리고 있어요 — 내일 이어서 할게요.</p>
        )}
        <button onClick={() => navigate('/dashboard')} className="mt-4 text-sm text-blue-600 underline">
          학습 대시보드 보기
        </button>
      </div>
    );
  }

  if (!currentRow) {
    // The row backing this slot disappeared (e.g. deleted mid-session) -- skip it.
    advance();
    return null;
  }

  const expr = toExpression(currentRow);

  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-xs text-slate-400">
        남은 카드: {queue!.slots.length - index}개 · 완료 {completedCount}개
      </p>

      {currentSlot.type === 'review' &&
        (expr.expression_examples?.[0] ? (
          <FillBlankCard
            key={currentSlot.reviewStateId}
            expressionFr={expr.expression_fr}
            exampleSentence={expr.expression_examples[0].sentence_fr}
            onRate={handleReviewRate}
          />
        ) : (
          <MeaningRecallCard key={currentSlot.reviewStateId} expressionFr={expr.expression_fr} meaningKo={expr.meaning_ko} onRate={handleReviewRate} />
        ))}

      {currentSlot.type !== 'review' && exerciseLoading && <p className="text-sm text-slate-400">문제 만드는 중...</p>}
      {currentSlot.type !== 'review' && exerciseError && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-500">문제 생성 실패: {exerciseError}</p>
          <button onClick={advance} className="text-sm text-slate-400 underline">
            건너뛰기
          </button>
        </div>
      )}
      {currentSlot.type !== 'review' && exercise && (
        <WritingModeCard slot={currentSlot} expressionId={expr.id} reviewRow={currentRow} exercise={exercise} onComplete={advance} />
      )}
    </div>
  );
}

function WritingModeCard({
  slot,
  expressionId,
  reviewRow,
  exercise,
  onComplete,
}: {
  slot: TodayQueueSlot;
  expressionId: string;
  reviewRow: ReviewStateQueryRow;
  exercise: GeneratedExercise;
  onComplete: () => void;
}) {
  const reviewState = toReviewStateRow(reviewRow);
  const shared = { expressionId, reviewStateId: slot.reviewStateId, reviewState, exercise, onComplete };
  if (slot.type === 'speaking') return <SpeakingCard {...shared} />;
  if (exercise.mode === 'situational') return <SituationalCard {...shared} />;
  if (exercise.mode === 'transform') return <TransformCard {...shared} />;
  return <KoreanPromptCard {...shared} />;
}
