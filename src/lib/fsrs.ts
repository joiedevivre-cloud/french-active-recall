import { fsrs, generatorParameters, Rating, State, type Card } from 'ts-fsrs';

// Default FSRS parameters. If/when enough review history accumulates,
// these can be re-optimized per-user (out of scope for Phase 1).
// request_retention is user-configurable (user_settings.desired_retention,
// migration 0015) -- 0.9 here matches both ts-fsrs's own default and that
// column's default, so omitting requestRetention below is 100%
// behavior-preserving for every existing caller.
const DEFAULT_REQUEST_RETENTION = 0.9;

function buildScheduler(requestRetention: number = DEFAULT_REQUEST_RETENTION) {
  return fsrs(generatorParameters({ enable_fuzz: true, request_retention: requestRetention }));
}

const scheduler = buildScheduler();

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
  /**
   * Retrievability AT THE MOMENT OF THE LAST REVIEW (migration 0015) --
   * a snapshot, not a live value. null for a card never reviewed yet.
   * Use estimateCurrentRetrievability() for a live-now estimate.
   */
  last_retrievability?: number | null;
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

function normalizeRetrievability(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Applies one FSRS review to a review_states row and returns the new row to
 * persist. The caller is responsible for writing both this and a matching
 * review_attempts record -- this function never touches the database itself,
 * so response_time_ms / AI feedback can never leak into the FSRS state by
 * accident (spec rule: only an explicit Again/Hard/Good/Easy rating moves
 * the scheduler). requestRetention is optional (user_settings.desired_retention) --
 * omitting it keeps the exact pre-existing 0.9 default.
 */
export function scheduleReview(row: ReviewStateRow, rating: DbRating, now: Date = new Date(), requestRetention?: number): ReviewStateRow {
  const activeScheduler = requestRetention === undefined ? scheduler : buildScheduler(requestRetention);
  const card = rowToCard(row);
  // Retrievability right before this review is applied -- "how likely were
  // they to recall it just now" -- independent of requestRetention (that
  // only steers which interval is scheduled, not the forgetting-curve math).
  const last_retrievability = normalizeRetrievability(scheduler.get_retrievability(card, now, false));
  const schedulingCards = activeScheduler.repeat(card, now);
  const next = schedulingCards[DB_TO_RATING[rating]].card;
  return { ...cardToRow(next), last_retrievability };
}

/**
 * Preview the interval each rating would produce, for showing e.g.
 * "Good -> 3d" hints on the rating buttons before the user picks one.
 */
export function previewIntervals(row: ReviewStateRow, now: Date = new Date(), requestRetention?: number): Record<DbRating, Card> {
  const activeScheduler = requestRetention === undefined ? scheduler : buildScheduler(requestRetention);
  const card = rowToCard(row);
  const schedulingCards = activeScheduler.repeat(card, now);
  return {
    again: schedulingCards[Rating.Again].card,
    hard: schedulingCards[Rating.Hard].card,
    good: schedulingCards[Rating.Good].card,
    easy: schedulingCards[Rating.Easy].card,
  };
}

/**
 * Live "right now" retrievability estimate for a card, e.g. for a "due
 * soon" list where recomputing per-card on the fly is cheap enough --
 * unlike review_states.last_retrievability (a stored snapshot from the
 * last review, used for cheap dashboard-wide averages), this always
 * reflects the current moment. Returns null for a card with no prior
 * review (not yet meaningful).
 */
export function estimateCurrentRetrievability(row: ReviewStateRow, now: Date = new Date()): number | null {
  if (!row.last_reviewed_at) return null;
  const card = rowToCard(row);
  return normalizeRetrievability(scheduler.get_retrievability(card, now, false));
}

export { RATING_TO_DB };
