/**
 * The review session: which cards get served, in what order, and how an answer
 * is applied exactly once.
 */

import { randomUUID } from 'node:crypto';
import type {
  AnswerOutcome,
  Ease,
  NextCardResponse,
  ReviewCard,
  SessionCounts,
  SessionState,
  SkipReason,
} from '../shared/types.js';
import { prepareCard, deckAllowed, type FilterConfig } from '../core/suitability.js';
import { stripInvisibleCharacters } from '../core/html.js';
import { AnkiClient, chunk, type AnkiCardInfo } from './ankiconnect.js';

export interface SessionOptions {
  filter: FilterConfig;
  /** Serve siblings of a note answered earlier in this session. */
  allowSiblings: boolean;
  /** Hard cap on cards served in one session. Null means no cap. */
  sessionLimit: number | null;
  /** Honour the per-deck daily limits Anki reports. */
  respectDailyLimits: boolean;
  /** Cards fetched from AnkiConnect per batch. */
  batchSize: number;
}

export const DEFAULT_SESSION_OPTIONS: Omit<SessionOptions, 'filter'> = {
  allowSiblings: false,
  sessionLimit: null,
  respectDailyLimits: true,
  batchSize: 40,
};

interface Candidate {
  cardId: number;
  /** The selected deck tree this card was found under. */
  root: string;
  /**
   * Which of the two daily allowances this card would draw on, from the query
   * that found it. Confirmed against the card itself before anything is spent.
   */
  learning: boolean;
}

interface Budget {
  learn: number;
  review: number;
}

/**
 * Anki's queues: 1 is learning, 3 is day learning, and relearning arrives as
 * type 3. Everything else due here is an ordinary review.
 */
function isLearning(info: { queue: number; type: number }): boolean {
  return info.queue === 1 || info.queue === 3 || info.type === 1 || info.type === 3;
}

interface ServedCard {
  cardId: number;
  noteId: number;
  servedAt: number;
  /** Review count when the card was served, to settle an ambiguous failure. */
  reps: number;
  /** Anki's own interval labels, in ease order Again, Hard, Good, Easy. */
  intervals: string[];
  /**
   * A grade was sent, the call failed, and Anki could not then say whether it
   * landed. Until it can, this card is neither graded nor safe to grade.
   */
  unresolved: boolean;
}

function quoteDeck(deck: string): string {
  return `"deck:${deck.replace(/["\\]/g, '\\$&')}"`;
}

/** Top level trees among the allowed decks, so limits are not counted twice. */
export function rootDecks(decks: string[]): string[] {
  const sorted = [...decks].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const deck of sorted) {
    const covered = roots.some(
      (root) => deck === root || deck.toLowerCase().startsWith(`${root.toLowerCase()}::`),
    );
    if (!covered) roots.push(deck);
  }
  return roots;
}

export class ReviewSession {
  readonly sessionId = randomUUID();

  private candidates: Candidate[] = [];
  private roots: string[] = [];
  /**
   * What Anki still allows today per deck tree, spent only when a card is
   * actually served. Learning and review are tracked apart, because a skipped
   * learning card must not create review capacity.
   */
  private readonly budgets = new Map<string, Budget>();
  private cursor = 0;
  private buffer: Array<{ info: AnkiCardInfo; candidate: Candidate }> = [];
  private tags = new Map<number, string[]>();

  private readonly served = new Map<string, ServedCard>();
  private readonly usedTokens = new Set<string>();
  private readonly answeredNotes = new Set<number>();
  private readonly seenCards = new Set<number>();

  private current: ReviewCard | null = null;
  private answered = 0;
  /**
   * Calls queued or running, so the session is not replaced under one. Counted
   * from the moment a call is queued, because a start request that arrives
   * while the first card is still being chosen would otherwise see an idle
   * session, replace it, and orphan the token that choice is about to return.
   */
  private pending = 0;

  private counts: SessionCounts = {
    due: 0,
    dailyAllowance: null,
    reviewable: 0,
    skipped: 0,
    skippedByReason: {},
  };

  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly anki: AnkiClient,
    private readonly options: SessionOptions,
  ) {}

  /** Serialize mutating calls so a double gesture cannot interleave. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.queue.then(task, task).finally(() => {
      this.pending -= 1;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async start(): Promise<SessionState> {
    return this.run(async () => {
      const allDecks = await this.anki.deckNames();
      const allowed = allDecks.filter((deck) => deckAllowed(deck, this.options.filter));
      const roots = rootDecks(allowed);

      const limits = new Map<string, Budget>();
      if (this.options.respectDailyLimits && allowed.length > 0) {
        // Every selected deck, not only the trees. A subdeck carries its own
        // daily limit, and Anki would not serve its cards past that even while
        // the parent still has allowance to spend.
        const stats = await this.anki.getDeckStats(allowed);
        for (const entry of Object.values(stats)) {
          limits.set(entry.name, { learn: entry.learn_count, review: entry.review_count });
        }
      }

      const ordered: Candidate[] = [];
      const seen = new Set<number>();
      for (const root of roots) {
        const scope = quoteDeck(root);
        // Coarse urgency order without pulling due values for every card.
        const buckets = [
          `${scope} is:due is:learn -is:suspended -is:buried`,
          `${scope} is:due -is:learn prop:due<=-1 -is:suspended -is:buried`,
          `${scope} is:due -is:learn -is:suspended -is:buried`,
        ];
        const forDeck: Candidate[] = [];
        for (const [index, query] of buckets.entries()) {
          const found = await this.anki.findCards(query);
          for (const id of found.sort((a, b) => a - b)) {
            if (!seen.has(id)) {
              seen.add(id);
              forDeck.push({ cardId: id, root, learning: index === 0 });
            }
          }
        }
        // The whole due list is kept. The daily allowance is spent when a card
        // is actually served, not on candidates the filter then holds back,
        // because trimming first can hide every readable card behind a run of
        // unreadable ones and report an empty session.
        ordered.push(...forDeck);
      }

      this.roots = roots;
      this.budgets.clear();
      for (const deck of allowed) {
        const limit = limits.get(deck);
        if (limit !== undefined) this.budgets.set(deck, { ...limit });
      }

      this.candidates = ordered;
      this.counts.due = ordered.length;
      // Summed over the trees only: a tree's count already covers its subdecks.
      this.counts.dailyAllowance =
        this.budgets.size > 0
          ? roots.reduce((total, root) => {
              const budget = this.budgets.get(root);
              return total + (budget === undefined ? 0 : budget.learn + budget.review);
            }, 0)
          : null;
      return this.state();
    });
  }

  state(): SessionState {
    return {
      sessionId: this.sessionId,
      counts: { ...this.counts, skippedByReason: { ...this.counts.skippedByReason } },
      answered: this.answered,
    };
  }

  /**
   * Is this session still worth resuming?
   *
   * A card on screen or a grade in flight always is. Otherwise it is only
   * worth resuming if it could still serve something: a session that stopped
   * because the day's allowance or the session limit ran out has to give way
   * to a fresh one, or restarting the app would show the wearer a finished
   * session forever even after they raised a deck limit.
   */
  isActive(): boolean {
    if (this.pending > 0 || this.current !== null) return true;
    if (this.options.sessionLimit !== null && this.answered >= this.options.sessionLimit) {
      return false;
    }
    if (this.allowanceExhausted()) return false;
    return this.buffer.length > 0 || this.cursor < this.candidates.length;
  }

  /** Budgets of this deck and of every deck above it, where Anki reported one. */
  private lineage(deck: string): Budget[] {
    const parts = deck.split('::');
    const budgets: Budget[] = [];
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const budget = this.budgets.get(parts.slice(0, depth).join('::'));
      if (budget !== undefined) budgets.push(budget);
    }
    return budgets;
  }

  /**
   * Can a card of this class in this deck still be served today? Anki applies
   * the limit of the deck and of every deck above it, so all of them need room.
   *
   * Checked per class rather than per deck, because a learning allowance that
   * cannot be spent, every learning card in the tree being a picture, would
   * otherwise keep the tree open and drag the whole review tail through the
   * filter for nothing.
   */
  private canSpend(deck: string, learning: boolean): boolean {
    return this.lineage(deck).every((budget) => (learning ? budget.learn : budget.review) > 0);
  }

  /** Spend one card of this class from the deck and every deck above it. */
  private spend(deck: string, learning: boolean): void {
    for (const budget of this.lineage(deck)) {
      if (learning) budget.learn -= 1;
      else budget.review -= 1;
    }
  }

  /** Has this deck tree spent every review Anki allowed it today? */
  private treeExhausted(root: string): boolean {
    const budget = this.budgets.get(root);
    return budget !== undefined && budget.learn <= 0 && budget.review <= 0;
  }

  /**
   * Nothing left to serve anywhere. A tree with no budget entry is unlimited,
   * so its presence means the session is not over.
   */
  private allowanceExhausted(): boolean {
    if (this.budgets.size === 0) return false;
    if (this.roots.some((root) => !this.budgets.has(root))) return false;
    return this.roots.every((root) => this.treeExhausted(root));
  }

  /**
   * Which of these cards Anki still considers due, asked fresh.
   *
   * Anki is open on the desktop for the whole run, so the due list this
   * session snapshotted at the start goes stale as the wearer reviews, buries
   * or suspends cards there.
   */
  private async stillDue(ids: number[]): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const found = await this.anki.findCards(
      `cid:${ids.join(',')} is:due -is:suspended -is:buried`,
    );
    return new Set(found);
  }

  /** Session size to show the wearer: due cards, capped by today's allowance. */
  private sessionTotal(): number {
    const allowance = this.counts.dailyAllowance;
    return allowance === null ? this.counts.due : Math.min(this.counts.due, allowance);
  }

  private noteSkip(reasons: SkipReason[]): void {
    this.counts.skipped += 1;
    for (const reason of reasons) {
      this.counts.skippedByReason[reason] = (this.counts.skippedByReason[reason] ?? 0) + 1;
    }
  }

  private async fillBuffer(): Promise<void> {
    while (this.buffer.length === 0 && this.cursor < this.candidates.length) {
      const batch: Candidate[] = [];
      let end = this.cursor;
      while (end < this.candidates.length && batch.length < this.options.batchSize) {
        const candidate = this.candidates[end];
        end += 1;
        // A card whose allowance is already spent cannot be served today, so
        // do not pay a round trip to fetch its html.
        if (candidate !== undefined && this.canSpend(candidate.root, candidate.learning)) {
          batch.push(candidate);
        }
      }
      if (batch.length === 0) {
        this.cursor = end;
        continue;
      }

      const ids = batch.map((candidate) => candidate.cardId);
      const fetched = await this.anki.cardsInfo(ids);

      // Keep the queue order this session chose rather than trusting the
      // order AnkiConnect happens to answer in.
      const byId = new Map(fetched.map((entry) => [entry.cardId, entry]));
      const usable: Array<{ info: AnkiCardInfo; candidate: Candidate }> = [];
      for (const candidate of batch) {
        const info = byId.get(candidate.cardId);
        if (info !== undefined) usable.push({ info, candidate });
      }

      if (this.options.filter.excludeTags.length > 0 && usable.length > 0) {
        const notes = [...new Set(usable.map((entry) => entry.info.note))];
        for (const group of chunk(notes, 200)) {
          const tags = await this.anki.notesTags(group);
          for (const [noteId, value] of tags) this.tags.set(noteId, value);
        }
      }
      // The batch is consumed only now. A read that failed above leaves the
      // cursor where it was, so the retry asks for the same cards instead of
      // silently dropping them from the session.
      this.cursor = end;
      this.buffer = usable;
    }
  }

  async next(): Promise<NextCardResponse> {
    return this.run(() => this.nextInternal());
  }

  private async nextInternal(): Promise<NextCardResponse> {
    if (this.current) {
      return { done: false, card: this.current, state: this.state() };
    }
    if (this.options.sessionLimit !== null && this.answered >= this.options.sessionLimit) {
      return { done: true, state: this.state() };
    }

    if (this.allowanceExhausted()) return { done: true, state: this.state() };

    for (;;) {
      await this.fillBuffer();
      // Peeked, not taken: the card leaves the buffer only once the due check
      // below has answered, so a failed check leaves it for the retry.
      const entry = this.buffer[0];
      if (!entry) return { done: true, state: this.state() };
      const info = entry.info;
      const learning = isLearning(info);

      // The allowance can run out while this card sits in the buffer.
      if (!this.canSpend(info.deckName, learning)) {
        this.buffer.shift();
        continue;
      }

      if (this.seenCards.has(info.cardId)) {
        this.buffer.shift();
        continue;
      }

      if (!this.options.allowSiblings && this.answeredNotes.has(info.note)) {
        this.buffer.shift();
        continue;
      }

      const prepared = prepareCard(
        {
          deck: info.deckName,
          questionHtml: info.question,
          answerHtml: info.answer,
          tags: this.tags.get(info.note) ?? [],
          noteType: info.modelName,
        },
        this.options.filter,
      );

      if (!prepared.ok) {
        this.noteSkip(prepared.reasons);
        this.buffer.shift();
        continue;
      }

      // Anki is open on the desktop, so ask about this card now rather than
      // trusting what it said when the batch was fetched. A card reviewed or
      // buried there in the meantime must not be shown, and must not take the
      // allowance slot a card that is still due could have used.
      const due = await this.stillDue([info.cardId]);
      this.buffer.shift();
      this.seenCards.add(info.cardId);
      if (!due.has(info.cardId)) {
        this.counts.due = Math.max(0, this.counts.due - 1);
        continue;
      }

      // Spend the allowance of this card's deck and of every deck above it,
      // from the count that actually covers this card. A learning card Anki
      // will not let us serve must not become permission to serve an extra
      // review.
      this.spend(info.deckName, learning);

      this.counts.reviewable += 1;
      const token = randomUUID();
      this.served.set(token, {
        cardId: info.cardId,
        noteId: info.note,
        servedAt: Date.now(),
        reps: info.reps,
        unresolved: false,
        intervals: (info.nextReviews ?? []).map(stripInvisibleCharacters),
      });

      this.current = {
        cardId: info.cardId,
        noteId: info.note,
        deck: info.deckName,
        questionPages: prepared.questionPages,
        answerPages: prepared.answerPages,
        token,
        index: this.answered + 1,
        total: this.sessionTotal(),
      };
      return { done: false, card: this.current, state: this.state() };
    }
  }

  /**
   * Did a grade reach the collection after the call to Anki failed?
   * A review that landed increments the card's review count.
   *
   * Throws when Anki cannot answer. Reading that silence as "it did not land"
   * would release the token, and the card comes round again a minute later on
   * its next learning step, where the released token would grade it twice.
   */
  private async gradeLanded(record: ServedCard): Promise<boolean> {
    const [info] = await this.anki.cardsInfo([record.cardId]);
    if (info === undefined) throw new Error(`Anki did not return card ${record.cardId}`);
    return info.reps > record.reps;
  }

  /**
   * Apply a grade. The token is single use, so a gesture delivered twice
   * cannot grade the same card twice.
   */
  async answer(
    token: string,
    ease: Ease,
  ): Promise<{ ok: boolean; outcome: AnswerOutcome; interval?: string; next: NextCardResponse }> {
    return this.run(() => this.answerInternal(token, ease));
  }

  private async answerInternal(
    token: string,
    ease: Ease,
  ): Promise<{ ok: boolean; outcome: AnswerOutcome; interval?: string; next: NextCardResponse }> {
    const record = this.served.get(token);
    if (!record) {
      // A token this session never issued: the server restarted, or another
      // client started a session. The wearer chose a grade and it is not
      // going to be recorded, so say so rather than call it a repeat.
      return { ok: false, outcome: 'unknown-token', next: await this.nextInternal() };
    }
    if (this.usedTokens.has(token)) {
      if (!record.unresolved) {
        // The same gesture arrived twice. The card is already graded.
        return { ok: false, outcome: 'duplicate', next: await this.nextInternal() };
      }
      // An earlier grade for this card was left unsettled. Settle it before
      // anything else. This throws while Anki still cannot say, which is the
      // right answer: the wearer sees the failure and can try again.
      if (await this.gradeLanded(record)) {
        record.unresolved = false;
        this.answered += 1;
        this.answeredNotes.add(record.noteId);
        this.current = null;
        return { ok: false, outcome: 'duplicate', next: await this.nextInternal() };
      }
      record.unresolved = false;
      this.usedTokens.delete(token);
    }

    // The card was due when it went on screen. Between then and now the
    // wearer may have reviewed or buried it on the desktop, where Anki is
    // open. Grading it here would write a second review of a card they
    // never answered twice.
    const due = await this.stillDue([record.cardId]);
    if (!due.has(record.cardId)) {
      this.usedTokens.add(token);
      this.current = null;
      return { ok: false, outcome: 'not-due', next: await this.nextInternal() };
    }
    this.usedTokens.add(token);

    const interval = record.intervals[ease - 1];
    let applied: boolean;
    try {
      applied = await this.anki.answerCard(record.cardId, ease);
    } catch (error) {
      // A thrown call is ambiguous: the grade may or may not have reached
      // the collection. Ask Anki what actually happened rather than guessing.
      // Leaving the token consumed here would strand the card, because the
      // same card and token are served again and would be read as a repeat.
      let landed: boolean;
      try {
        landed = await this.gradeLanded(record);
      } catch {
        // Anki cannot say either. The token stays consumed and the card stays
        // on screen until it can, because releasing it now risks a second
        // review and holding it only costs the wearer a retry.
        record.unresolved = true;
        throw error;
      }
      if (!landed) {
        this.usedTokens.delete(token);
        throw error;
      }
      applied = true;
    }
    if (!applied) {
      this.usedTokens.delete(token);
      throw new Error(`Anki refused to grade card ${record.cardId}`);
    }

    this.answered += 1;
    this.answeredNotes.add(record.noteId);
    this.current = null;

    const next = await this.nextInternal();
    return { ok: true, outcome: 'graded', interval, next };
  }

}
