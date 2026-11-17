import type { DbRating } from '@/lib/fsrs';

const BUTTONS: { rating: DbRating; label: string; className: string }[] = [
  { rating: 'again', label: '다시 (Again)', className: 'bg-red-500' },
  { rating: 'hard', label: '어려움 (Hard)', className: 'bg-orange-500' },
  { rating: 'good', label: '좋음 (Good)', className: 'bg-green-600' },
  { rating: 'easy', label: '쉬움 (Easy)', className: 'bg-blue-600' },
];

export function RatingButtons({ onRate }: { onRate: (rating: DbRating) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {BUTTONS.map((b) => (
        <button
          key={b.rating}
          onClick={() => onRate(b.rating)}
          className={`rounded-xl py-3 text-sm font-semibold text-white ${b.className}`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
