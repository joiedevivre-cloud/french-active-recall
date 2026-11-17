import { useState } from 'react';
import type { DbRating } from '@/lib/fsrs';
import { normalizeFr } from '@/lib/normalizeFr';
import { RatingButtons } from '@/features/review/cards/RatingButtons';

interface FillBlankCardProps {
  expressionFr: string;
  exampleSentence: string;
  onRate: (rating: DbRating, hintUsed: boolean, responseTimeMs: number) => void;
}

function buildBlankedSentence(sentence: string, target: string): string {
  const index = sentence.toLowerCase().indexOf(target.toLowerCase());
  if (index === -1) return sentence;
  const blank = '_'.repeat(Math.max(target.length, 4));
  return sentence.slice(0, index) + blank + sentence.slice(index + target.length);
}

export function FillBlankCard({ expressionFr, exampleSentence, onRate }: FillBlankCardProps) {
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState(false);
  const [startedAt] = useState(() => Date.now());

  const blanked = buildBlankedSentence(exampleSentence, expressionFr);
  const isCorrect = normalizeFr(answer) === normalizeFr(expressionFr);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-3xl border border-slate-200 p-8 text-center dark:border-slate-800">
        <p className="text-lg">{blanked}</p>
      </div>

      {!checked ? (
        <div className="flex flex-col gap-3">
          <input
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="빈칸에 들어갈 표현을 입력하세요"
            className="w-full rounded-xl border border-slate-300 p-3 text-center text-lg dark:border-slate-700 dark:bg-slate-900"
          />
          <button onClick={() => setChecked(true)} className="rounded-full bg-blue-600 py-4 text-lg font-semibold text-white">
            확인
          </button>
        </div>
      ) : (
        <>
          <p className={`text-center text-lg font-semibold ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
            정답: {expressionFr}
          </p>
          <RatingButtons onRate={(rating) => onRate(rating, false, Date.now() - startedAt)} />
        </>
      )}
    </div>
  );
}
