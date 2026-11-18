import type { ReviewStateRow } from '@/lib/fsrs';
import { WritingCardShell } from '@/features/review/cards/WritingCardShell';
import type { GeneratedExercise } from '@/features/today/writingPracticeClient';

export interface WritingModeCardProps {
  expressionId: string;
  reviewStateId: string;
  reviewState: ReviewStateRow;
  exercise: GeneratedExercise;
  onComplete: () => void;
}

export function TransformCard({ expressionId, reviewStateId, reviewState, exercise, onComplete }: WritingModeCardProps) {
  return (
    <WritingCardShell
      expressionId={expressionId}
      reviewStateId={reviewStateId}
      reviewState={reviewState}
      mode="transform"
      exerciseId={exercise.id}
      grammarTags={exercise.grammarTags}
      targetGrammar={exercise.promptFrPattern}
      onComplete={onComplete}
      promptHeader={
        <div className="rounded-3xl border border-slate-200 p-8 dark:border-slate-800">
          <p className="text-xs text-slate-400">문장 변형</p>
          <p className="mt-2 text-lg">{exercise.promptKo}</p>
          {exercise.promptFrPattern && <p className="mt-3 text-sm text-slate-400">목표 문법: {exercise.promptFrPattern}</p>}
        </div>
      }
      renderInput={(value, setValue) => (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="프랑스어로 작성하세요"
          className="w-full rounded-xl border border-slate-300 p-3 text-base dark:border-slate-700 dark:bg-slate-900"
          rows={3}
        />
      )}
    />
  );
}
