/**
 * A small stand in for AnkiConnect, used by the end to end run so a test never
 * touches a real collection. It implements only the actions this app calls,
 * and records every grade so the test can assert what Anki would have been
 * told.
 */

import { createServer, type Server } from 'node:http';

export interface MockCard {
  cardId: number;
  note: number;
  deckName: string;
  modelName: string;
  question: string;
  answer: string;
  tags: string[];
  isLearn: boolean;
  overdue: boolean;
  suspended?: boolean;
}

const STYLE = '<style>.card { font-family: arial; font-size: 20px; }</style>';

function card(partial: Partial<MockCard> & Pick<MockCard, 'cardId' | 'question' | 'answer'>): MockCard {
  return {
    note: partial.cardId,
    deckName: 'Demo',
    modelName: 'Basic',
    tags: [],
    isLearn: false,
    overdue: false,
    ...partial,
  };
}

/** A fixture collection with one of every case the filter has to handle. */
export function defaultCards(): MockCard[] {
  return [
    card({
      cardId: 1001,
      question: `${STYLE}What is the capital of France?`,
      answer: `${STYLE}What is the capital of France?<hr id=answer>Paris`,
    }),
    card({
      cardId: 1002,
      question: `${STYLE}Identify this structure<br><img src="mitochondria.png">`,
      answer: `${STYLE}<hr id=answer>Mitochondrion`,
    }),
    card({
      cardId: 1003,
      question: `${STYLE}Listen and translate [sound:track01.mp3]`,
      answer: `${STYLE}<hr id=answer>Good morning`,
    }),
    card({
      cardId: 1004,
      question: `${STYLE}Summarise the causes of the 1929 crash`,
      answer: `${STYLE}<hr id=answer>${'Speculation on margin drove valuations far beyond earnings, and when brokers called in loans the selling fed on itself. '.repeat(
        6,
      )}`,
    }),
    card({
      cardId: 1005,
      deckName: 'Demo::Sub',
      question: `${STYLE}Which enzyme unwinds DNA?`,
      answer: `${STYLE}<hr id=answer>Helicase`,
      isLearn: true,
    }),
    card({
      cardId: 1006,
      question: `${STYLE}Compare the three eras<table><tr><td>a</td></tr></table>`,
      answer: `${STYLE}<hr id=answer>See table`,
    }),
    card({
      cardId: 1007,
      question: `${STYLE}Solve \\(x^2 + 2x + 1 = 0\\)`,
      answer: `${STYLE}<hr id=answer>x = -1`,
    }),
    // Two cards on the same note, to prove siblings are not both served.
    card({
      cardId: 1008,
      note: 1008,
      question: `${STYLE}Front of the shared note`,
      answer: `${STYLE}<hr id=answer>Back of the shared note`,
    }),
    card({
      cardId: 1009,
      note: 1008,
      question: `${STYLE}Back of the shared note`,
      answer: `${STYLE}<hr id=answer>Front of the shared note`,
    }),
    card({
      cardId: 1010,
      question: `${STYLE}Tagged out of glasses reviews`,
      answer: `${STYLE}<hr id=answer>Should not appear`,
      tags: ['noglasses'],
    }),
    card({
      cardId: 1011,
      question: `${STYLE}Who wrote the Theory of Moral Sentiments?`,
      answer: `${STYLE}<hr id=answer>Adam Smith`,
      overdue: true,
    }),
  ];
}

export interface MockAnki {
  port: number;
  url: string;
  answers: Array<{ cardId: number; ease: number }>;
  close: () => Promise<void>;
  cards: MockCard[];
  /**
   * Make the next answerCards call fail, to exercise recovery.
   * 'drop' fails without recording. 'apply-then-fail' records the review and
   * then fails the response, which is what a timeout after a successful write
   * looks like from the caller's side.
   */
  failNextAnswer: null | 'drop' | 'apply-then-fail';
  /**
   * Make the next cardsInfo call fail, to exercise a grade whose outcome
   * cannot be settled because Anki went away mid recovery.
   */
  failNextCardsInfo: boolean;
  /** Make the next findCards call fail, to exercise a due check that dies. */
  failNextFindCards: boolean;
  /** Stand in for a review, bury or suspend done on the desktop mid-session. */
  markNotDue: (cardId: number) => void;
  /** Every action asked for, in order, so a test can assert on the work done. */
  calls: string[];
}

function matchesDeck(deckClause: string | null, deck: string): boolean {
  if (!deckClause) return true;
  return deck === deckClause || deck.startsWith(`${deckClause}::`);
}

export interface MockLimits {
  newCount?: number;
  learnCount?: number;
  reviewCount?: number;
}

export interface MockOptions {
  /** Force the counts getDeckStats reports, to exercise daily limit handling. */
  limits?: MockLimits;
  /** The same, per deck, for a subdeck whose own limit differs from its parent's. */
  limitsByDeck?: Record<string, MockLimits>;
}

export async function startMockAnki(
  cards: MockCard[] = defaultCards(),
  options: MockOptions = {},
): Promise<MockAnki> {
  const answers: Array<{ cardId: number; ease: number }> = [];
  const reps = new Map<number, number>();
  // A graded card stops being due, the same as in a real collection. Tests
  // also add to this directly to stand in for a review done on the desktop.
  const notDue = new Set<number>();
  const calls: string[] = [];
  let failNextAnswer: MockAnki['failNextAnswer'] = null;
  let failNextCardsInfo = false;
  let failNextFindCards = false;

  const findCards = (query: string): number[] => {
    const deckMatch = query.match(/"deck:([^"]+)"/);
    const deckClause = deckMatch ? deckMatch[1] : null;
    const excludeSub = query.includes('-"deck:') && query.includes('::*"');
    const wantLearn = /(?<!-)\bis:learn\b/.test(query);
    const excludeLearn = /-is:learn\b/.test(query);
    const wantOverdue = /prop:due<=-1/.test(query);
    const wantDue = /(?<!-)\bis:due\b/.test(query);
    const cidMatch = query.match(/\bcid:([\d,]+)/);
    const cids = cidMatch ? new Set(cidMatch[1].split(',').map(Number)) : null;

    return cards
      .filter((entry) => {
        if (entry.suspended) return false;
        if (cids && !cids.has(entry.cardId)) return false;
        if (wantDue && notDue.has(entry.cardId)) return false;
        if (!matchesDeck(deckClause, entry.deckName)) return false;
        if (excludeSub && deckClause && entry.deckName !== deckClause) return false;
        if (wantLearn && !entry.isLearn) return false;
        if (excludeLearn && entry.isLearn) return false;
        if (wantOverdue && !entry.overdue) return false;
        return true;
      })
      .map((entry) => entry.cardId);
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const piece of req) chunks.push(piece as Buffer);
    let action = '';
    let params: Record<string, unknown> = {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      action = body.action;
      params = body.params ?? {};
    } catch {
      // fall through to the unknown action reply
    }

    const reply = (result: unknown, error: string | null = null) => {
      const payload = JSON.stringify({ result, error });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    calls.push(action);

    switch (action) {
      case 'version':
        return reply(6);

      case 'deckNames': {
        // A parent deck exists whenever a subdeck does, as in a real collection.
        const names = new Set<string>();
        for (const entry of cards) {
          const parts = entry.deckName.split('::');
          for (let depth = 1; depth <= parts.length; depth += 1) {
            names.add(parts.slice(0, depth).join('::'));
          }
        }
        return reply([...names]);
      }

      case 'getDeckStats': {
        const decks = (params.decks as string[]) ?? [];
        const stats: Record<string, unknown> = {};
        for (const deck of decks) {
          const inTree = cards.filter((entry) => matchesDeck(deck, entry.deckName));
          const forced = options.limitsByDeck?.[deck] ?? options.limits;
          stats[String(deck)] = {
            deck_id: 1,
            name: deck,
            new_count: forced?.newCount ?? 0,
            learn_count: forced?.learnCount ?? inTree.filter((entry) => entry.isLearn).length,
            review_count: forced?.reviewCount ?? inTree.filter((entry) => !entry.isLearn).length,
            total_in_deck: inTree.length,
          };
        }
        return reply(stats);
      }

      case 'findCards':
        if (failNextFindCards) {
          failNextFindCards = false;
          res.destroy();
          return;
        }
        return reply(findCards(String(params.query ?? '')));

      case 'cardsInfo': {
        if (failNextCardsInfo) {
          failNextCardsInfo = false;
          res.destroy();
          return;
        }
        // Real AnkiConnect answers in the order the ids were asked for.
        const requested = (params.cards as number[]) ?? [];
        const byId = new Map(cards.map((entry) => [entry.cardId, entry]));
        return reply(
          requested
            .map((id) => byId.get(id))
            .filter((entry): entry is MockCard => entry !== undefined)
            .map((entry) => ({
              cardId: entry.cardId,
              note: entry.note,
              deckName: entry.deckName,
              modelName: entry.modelName,
              question: entry.question,
              answer: entry.answer,
              due: 1,
              type: entry.isLearn ? 1 : 2,
              queue: entry.isLearn ? 1 : 2,
              interval: 10,
              reps: reps.get(entry.cardId) ?? 3,
              lapses: 0,
              nextReviews: ['<⁨1⁩m', '<⁨10⁩m', '⁨4⁩d', '⁨10⁩d'],
            })),
        );
      }

      case 'notesInfo': {
        const ids = new Set((params.notes as number[]) ?? []);
        const seen = new Map<number, string[]>();
        for (const entry of cards) {
          if (ids.has(entry.note) && !seen.has(entry.note)) seen.set(entry.note, entry.tags);
        }
        return reply([...seen].map(([noteId, tags]) => ({ noteId, tags })));
      }

      case 'answerCards': {
        const list = (params.answers as Array<{ cardId: number; ease: number }>) ?? [];
        const mode = failNextAnswer;
        if (mode !== null) {
          failNextAnswer = null;
          if (mode === 'apply-then-fail') {
            for (const entry of list) {
              answers.push(entry);
              reps.set(entry.cardId, (reps.get(entry.cardId) ?? 3) + 1);
              notDue.add(entry.cardId);
            }
          }
          res.destroy();
          return;
        }
        for (const entry of list) {
          answers.push(entry);
          reps.set(entry.cardId, (reps.get(entry.cardId) ?? 3) + 1);
          notDue.add(entry.cardId);
        }
        return reply(list.map(() => true));
      }

      default:
        return reply(null, `mock does not implement ${action}`);
    }
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    answers,
    cards,
    calls,
    get failNextAnswer() {
      return failNextAnswer;
    },
    set failNextAnswer(value: MockAnki['failNextAnswer']) {
      failNextAnswer = value;
    },
    get failNextCardsInfo() {
      return failNextCardsInfo;
    },
    set failNextCardsInfo(value: boolean) {
      failNextCardsInfo = value;
    },
    get failNextFindCards() {
      return failNextFindCards;
    },
    set failNextFindCards(value: boolean) {
      failNextFindCards = value;
    },
    markNotDue: (cardId: number) => {
      notDue.add(cardId);
    },
    close: () => new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
  };
}
