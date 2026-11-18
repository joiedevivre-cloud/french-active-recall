import type { DbRating } from '@/lib/fsrs';

const BUTTONS: { rating: DbRating; label: string; className: string }[] = [
  { rating: 'again', label: '다시 (Again)', className: 'bg-red-500' },
  { rating: 'hard', label: '어려움 (Hard)', className: 'bg-orange-500' },
  { rating: 'good', label: '좋음 (Good)', className: 'bg-green-600' },
  { rating: 'easy', label: '쉬움 (Easy)', className: 'bg-blue-600' },
];

interface RatingButtonsProps {
  onRate: (rating: DbRating) => void;
  /** AI's advisory suggestion (writing-practice correction) -- visually marked, never auto-applied; the user still picks. */
  suggestedRating?: DbRating | null;
}

export function RatingButtons({ onRate, suggestedRating }: RatingButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {BUTTONS.map((b) => (
        <button
          key={b.rating}
          onClick={() => onRate(b.rating)}
          className={`rounded-xl py-3 text-sm font-semibold text-white ${b.className} ${
            suggestedRating === b.rating ? 'ring-4 ring-offset-2 ring-yellow-400' : ''
          }`}
        >
          {b.label}
          {suggestedRating === b.rating && <span className="ml-1 text-xs">(AI 추천)</span>}
        </button>
      ))}
    </div>
  );
}
