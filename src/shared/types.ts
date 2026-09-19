/**
 * Shared types between the server and the glasses web app.
 */

/** Anki ease values as the scheduler understands them. */
export type Ease = 1 | 2 | 3 | 4;

export const EASE_AGAIN: Ease = 1;
export const EASE_HARD: Ease = 2;
export const EASE_GOOD: Ease = 3;
export const EASE_EASY: Ease = 4;

export const EASE_LABELS: Record<Ease, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

/** Every gesture the glasses or the ring can deliver that this app uses. */
export type Gesture =
  | 'click'
  | 'double_click'
  | 'up'
  | 'down'
  | 'long_press';

/** Where a gesture came from. Advisory only, see notes in the readme. */
export type GestureSource = 'ring' | 'glasses_left' | 'glasses_right' | 'unknown';

/**
 * Reasons a card can be held back from a glasses review.
 * Each reason is reported separately so the skip report is explainable.
 */
export type SkipReason =
  | 'image'
  | 'media'
  | 'math'
  | 'table'
  | 'markup'
  | 'too-long'
  | 'empty'
  | 'deck-excluded'
  | 'tag-excluded'
  | 'note-type-excluded';

export interface Suitability {
  ok: boolean;
  reasons: SkipReason[];
  /** Longest plain-text side in characters, for reporting and tuning. */
  longestSide: number;
}

/** A card prepared for the glasses: plain text, already paginated. */
export interface ReviewCard {
  cardId: number;
  noteId: number;
  deck: string;
  questionPages: string[];
  answerPages: string[];
  /**
   * Single-use token. The app must return it to grade this card.
   * A repeated or stale token is rejected, so a duplicated gesture event
   * cannot grade the same card twice.
   */
  token: string;
  /** Position in the session queue, for the progress line. */
  index: number;
  total: number;
}

export interface SessionCounts {
  /** Cards Anki says are due within the selected decks. */
  due: number;
  /**
   * Reviews Anki's own per-deck daily limits still allow today, summed over
   * the selected deck trees. Null when limits are not being honoured.
   */
  dailyAllowance: number | null;
  /** Of those, cards that survive the suitability filter. */
  reviewable: number;
  /** Of those, cards held back, by reason. */
  skipped: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
}

export interface SessionState {
  sessionId: string;
  counts: SessionCounts;
  answered: number;
}

export interface NextCardResponse {
  done: boolean;
  card?: ReviewCard;
  state: SessionState;
}

export interface AnswerRequest {
  token: string;
  ease: Ease;
  /** Milliseconds the card was on screen, for Anki's review log. */
  timeTakenMs?: number;
}

/**
 * What became of a grade. Anything other than `graded` means the collection
 * was not written, and each one means something different to the wearer, so
 * they are not collapsed into one flag.
 */
export type AnswerOutcome =
  /** The grade reached Anki. */
  | 'graded'
  /** This token already graded its card. A gesture arrived twice. */
  | 'duplicate'
  /** The token is not from the running session, so nothing was graded. */
  | 'unknown-token'
  /** The card stopped being due between being shown and being graded. */
  | 'not-due';

export interface AnswerResponse {
  ok: boolean;
  outcome: AnswerOutcome;
  /** Human readable interval Anki assigned, for the confirmation line. */
  interval?: string;
  next: NextCardResponse;
}

export interface DeckReport {
  deck: string;
  due: number;
  reviewable: number;
  skipped: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
  /** True when the whole deck is excluded by configuration. */
  excluded: boolean;
}
