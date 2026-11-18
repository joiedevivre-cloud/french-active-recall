import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import { scheduleReview, type DbRating, type ReviewStateRow } from '@/lib/fsrs';
import { confirmReviewGrade } from '@/features/review/confirmReviewGrade';
import { MeaningRecallCard } from '@/features/review/cards/MeaningRecallCard';
import { FillBlankCard } from '@/features/review/cards/FillBlankCard';

interface ReviewCard {
  reviewStateId: string;
  expressionId: string;
  expressionFr: string;
  meaningKo: string | null;
  exampleSentence: string | null;
  attemptType: 'meaning_recall' | 'fill_blank';
  reviewState: ReviewStateRow;
  consecutiveCorrect: number;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function TodayReview() {
  const { user } = useAuth();
  const { settings } = useSettings();
  const [searchParams] = useSearchParams();
  const scope = searchParams.get('scope');
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [completedCount, setCompletedCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    void loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, scope]);

  async function loadQueue() {
    if (!user) return;
    const limit = 15;

    if (scope === 'today') {
      const { data, error } = await supabase
        .from('expressions')
        .select(
          `id, expression_fr, meaning_ko,
           expression_examples ( sentence_fr ),
           review_states ( id, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_reviewed_at, consecutive_correct )`
        )
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .gte('created_at', startOfTodayIso())
        .limit(limit);

      if (error || !data) {
        setQueue([]);
        return;
      }

      const cards = data
        .filter((row) => row.review_states && row.review_states.length > 0)
        .map((row) => toCard(row))
        .sort((a, b) => a.reviewState.reps - b.reviewState.reps);

      setQueue(cards);
      return;
    }

    const { data, error } = await supabase
      .from('review_states')
      .select(
        `id, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_reviewed_at, consecutive_correct,
         expression_id,
         expressions!inner ( id, expression_fr, meaning_ko, deleted_at, expression_examples ( sentence_fr ) )`
      )
      .eq('user_id', user.id)
      .lte('due_at', new Date().toISOString())
      .is('expressions.deleted_at', null)
      .order('due_at', { ascending: true })
      .limit(limit);

    if (error || !data) {
      setQueue([]);
      return;
    }

    const cards = data.map((row) => {
      const expr = Array.isArray(row.expressions) ? row.expressions[0] : row.expressions;
      const example = expr?.expression_examples?.[0]?.sentence_fr ?? null;
      return {
        reviewStateId: row.id,
        expressionId: row.expression_id,
        expressionFr: expr?.expression_fr ?? '',
        meaningKo: expr?.meaning_ko ?? null,
        exampleSentence: example,
        attemptType: example ? ('fill_blank' as const) : ('meaning_recall' as const),
        reviewState: {
          due_at: row.due_at,
          stability: row.stability,
          difficulty: row.difficulty,
          elapsed_days: row.elapsed_days,
          scheduled_days: row.scheduled_days,
          reps: row.reps,
          lapses: row.lapses,
          state: row.state,
          last_reviewed_at: row.last_reviewed_at,
        },
        consecutiveCorrect: row.consecutive_correct,
      };
    });

    setQueue(cards);
  }

  function toCard(row: any): ReviewCard {
    const rs = row.review_states[0];
    const example = row.expression_examples?.[0]?.sentence_fr ?? null;
    return {
      reviewStateId: rs.id,
      expressionId: row.id,
      expressionFr: row.expression_fr,
      meaningKo: row.meaning_ko,
      exampleSentence: example,
      attemptType: example ? 'fill_blank' : 'meaning_recall',
      reviewState: {
        due_at: rs.due_at,
        stability: rs.stability,
        difficulty: rs.difficulty,
        elapsed_days: rs.elapsed_days,
        scheduled_days: rs.scheduled_days,
        reps: rs.reps,
        lapses: rs.lapses,
        state: rs.state,
        last_reviewed_at: rs.last_reviewed_at,
      },
      consecutiveCorrect: rs.consecutive_correct,
    };
  }

  async function handleRate(rating: DbRating, hintUsed: boolean, responseTimeMs: number) {
    if (!user || !queue || queue.length === 0) return;
    const current = queue[0];
    const nextRow = scheduleReview(current.reviewState, rating, new Date(), settings?.desired_retention);

    // Atomic + idempotent (migration 0015's confirm_review_grade RPC):
    // a retried network call with the same clientId can never double-apply
    // this FSRS rep, unlike the previous two-separate-writes approach.
    await confirmReviewGrade(crypto.randomUUID(), {
      reviewStateId: current.reviewStateId,
      expressionId: current.expressionId,
      rating,
      attemptType: current.attemptType,
      newReviewState: nextRow,
      responseTimeMs,
      hintUsed,
    });

    setCompletedCount((c) => c + 1);
    setQueue((prev) => {
      if (!prev) return prev;
      const [, ...rest] = prev;
      // "Again" means we didn't recall it -- requeue at the end of THIS
      // session so it comes back up before the session ends (spec §9).
      return rating === 'again' ? [...rest, current] : rest;
    });
  }

  if (!queue) {
    return <div className="p-5 text-sm text-slate-400">불러오는 중...</div>;
  }

  if (queue.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
        <p className="text-lg font-semibold">복습할 표현이 없어요</p>
        <p className="text-sm text-slate-400">완료 {completedCount}개</p>
      </div>
    );
  }

  const current = queue[0];

  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-xs text-slate-400">남은 카드: {queue.length}개 · 완료 {completedCount}개</p>
      {current.attemptType === 'fill_blank' && current.exampleSentence ? (
        <FillBlankCard
          key={current.reviewStateId + queue.length}
          expressionFr={current.expressionFr}
          exampleSentence={current.exampleSentence}
          onRate={handleRate}
        />
      ) : (
        <MeaningRecallCard
          key={current.reviewStateId + queue.length}
          expressionFr={current.expressionFr}
          meaningKo={current.meaningKo}
          onRate={handleRate}
        />
      )}
    </div>
  );
}
