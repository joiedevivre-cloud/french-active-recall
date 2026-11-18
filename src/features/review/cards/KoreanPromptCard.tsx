import type { WritingModeCardProps } from '@/features/review/cards/TransformCard';
import { WritingCardShell } from '@/features/review/cards/WritingCardShell';

export function KoreanPromptCard({ expressionId, reviewStateId, reviewState, exercise, onComplete }: WritingModeCardProps) {
  return (
    <WritingCardShell
      expressionId={expressionId}
      reviewStateId={reviewStateId}
      reviewState={reviewState}
      mode="korean_prompt"
      exerciseId={exercise.id}
      grammarTags={exercise.grammarTags}
      targetGrammar={exercise.promptFrPattern}
      onComplete={onComplete}
      promptHeader={
        <div className="rounded-3xl border border-slate-200 p-8 dark:border-slate-800">
          <p className="text-xs text-slate-400">한국어 → 프랑스어 작문</p>
          <p className="mt-2 text-lg">{exercise.promptKo}</p>
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
