import { fsrs, generatorParameters, Rating, State, type Card } from 'ts-fsrs';

// Default FSRS parameters. If/when enough review history accumulates,
// these can be re-optimized per-user (out of scope for Phase 1).
const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

export type DbReviewState = 'new' | 'learning' | 'review' | 'relearning';
export type DbRating = 'again' | 'hard' | 'good' | 'easy';

const STATE_TO_DB: Record<State, DbReviewState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const DB_TO_STATE: Record<DbReviewState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const RATING_TO_DB: Record<Rating.Again | Rating.Hard | Rating.Good | Rating.Easy, DbRating> = {
  [Rating.Again]: 'again',
  [Rating.Hard]: 'hard',
  [Rating.Good]: 'good',
  [Rating.Easy]: 'easy',
};

const DB_TO_RATING: Record<DbRating, Rating.Again | Rating.Hard | Rating.Good | Rating.Easy> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

// Mirrors the subset of review_states columns the scheduler needs to read
// and write (see supabase/migrations/0001_core_schema.sql).
export interface ReviewStateRow {
  due_at: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: DbReviewState;
  last_reviewed_at: string | null;
}

function rowToCard(row: ReviewStateRow): Card {
  return {
    due: new Date(row.due_at),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: DB_TO_STATE[row.state],
    last_review: row.last_reviewed_at ? new Date(row.last_reviewed_at) : undefined,
  };
}

function cardToRow(card: Card): ReviewStateRow {
  return {
    due_at: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_DB[card.state],
    last_reviewed_at: card.last_review ? card.last_review.toISOString() : null,
  };
}

/**
 * Applies one FSRS review to a review_states row and returns the new row to
 * persist. The caller is responsible for writing both this and a matching
 * review_attempts record -- this function never touches the database itself,
 * so response_time_ms / AI feedback can never leak into the FSRS state by
 * accident (spec rule: only an explicit Again/Hard/Good/Easy rating moves
 * the scheduler).
 */
export function scheduleReview(row: ReviewStateRow, rating: DbRating, now: Date = new Date()): ReviewStateRow {
  const card = rowToCard(row);
  const schedulingCards = scheduler.repeat(card, now);
  const next = schedulingCards[DB_TO_RATING[rating]].card;
  return cardToRow(next);
}

/**
 * Preview the interval each rating would produce, for showing e.g.
 * "Good -> 3d" hints on the rating buttons before the user picks one.
 */
export function previewIntervals(row: ReviewStateRow, now: Date = new Date()): Record<DbRating, Card> {
  const card = rowToCard(row);
  const schedulingCards = scheduler.repeat(card, now);
  return {
    again: schedulingCards[Rating.Again].card,
    hard: schedulingCards[Rating.Hard].card,
    good: schedulingCards[Rating.Good].card,
    easy: schedulingCards[Rating.Easy].card,
  };
}

export { RATING_TO_DB };
