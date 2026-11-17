import { useState } from 'react';
import type { DbRating } from '@/lib/fsrs';
import { RatingButtons } from '@/features/review/cards/RatingButtons';

interface MeaningRecallCardProps {
  expressionFr: string;
  meaningKo: string | null;
  onRate: (rating: DbRating, hintUsed: boolean, responseTimeMs: number) => void;
}

export function MeaningRecallCard({ expressionFr, meaningKo, onRate }: MeaningRecallCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [hintUsed, setHintUsed] = useState(false);
  const [startedAt] = useState(() => Date.now());

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-3xl border border-slate-200 p-8 text-center dark:border-slate-800">
        <p className="text-2xl font-semibold">{expressionFr}</p>
        {revealed && <p className="mt-4 text-lg text-slate-500">{meaningKo ?? '(한국어 뜻 없음)'}</p>}
      </div>

      {!revealed && (
        <div className="flex flex-col gap-3">
          <button
            onClick={() => setRevealed(true)}
            className="rounded-full bg-blue-600 py-4 text-lg font-semibold text-white"
          >
            뜻 확인
          </button>
          <button onClick={() => setHintUsed(true)} className="text-sm text-slate-400 underline">
            힌트가 필요해요
          </button>
          {hintUsed && <p className="text-center text-sm text-slate-400">첫 글자: {meaningKo?.[0] ?? '?'}</p>}
        </div>
      )}

      {revealed && (
        <RatingButtons onRate={(rating) => onRate(rating, hintUsed, Date.now() - startedAt)} />
      )}
    </div>
  );
}
