import type { WritingModeCardProps } from '@/features/review/cards/TransformCard';
import { WritingCardShell } from '@/features/review/cards/WritingCardShell';

export function SituationalCard({ expressionId, reviewStateId, reviewState, exercise, onComplete }: WritingModeCardProps) {
  const scenario = exercise.scenarioContext;
  return (
    <WritingCardShell
      expressionId={expressionId}
      reviewStateId={reviewStateId}
      reviewState={reviewState}
      mode="situational"
      exerciseId={exercise.id}
      grammarTags={exercise.grammarTags}
      onComplete={onComplete}
      promptHeader={
        <div className="rounded-3xl border border-slate-200 p-8 dark:border-slate-800">
          <p className="text-xs text-slate-400">실생활 상황 작문</p>
          {scenario && <p className="mt-1 text-sm font-medium text-slate-500">{scenario.role_ko}</p>}
          <p className="mt-2 text-lg">{exercise.promptKo}</p>
          {scenario?.constraints_ko && <p className="mt-2 text-sm text-slate-400">{scenario.constraints_ko}</p>}
        </div>
      }
      renderInput={(value, setValue) => (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="프랑스어로 작성하세요"
          className="w-full rounded-xl border border-slate-300 p-3 text-base dark:border-slate-700 dark:bg-slate-900"
          rows={4}
        />
      )}
    />
  );
}
