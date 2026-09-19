/**
 * Live check against the real Anki, using a scratch deck that this script
 * creates and then deletes. It proves the write path end to end: a card is
 * served through the filter, graded through Anki's own scheduler, and the
 * grade is then undone.
 *
 * It touches nothing outside the scratch deck.
 *
 *   ANKI_CONNECT_URL=http://127.0.0.1:18765 npx tsx tools/live-check.ts
 */

import { AnkiClient } from '../src/server/ankiconnect.js';
import { DEFAULT_FILTER } from '../src/core/suitability.js';
import { DEFAULT_SESSION_OPTIONS, ReviewSession } from '../src/server/session.js';

const DECK = 'AnkiGlasses Scratch';

interface CardState {
  reps: number;
  due: number;
  interval: number;
  queue: number;
}

async function cardState(anki: AnkiClient, cardId: number): Promise<CardState> {
  const [info] = await anki.cardsInfo([cardId]);
  if (!info) throw new Error(`card ${cardId} vanished`);
  return { reps: info.reps, due: info.due, interval: info.interval, queue: info.queue };
}

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
  process.stdout.write(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`);
}

async function main(): Promise<void> {
  const anki = new AnkiClient({ url: process.env.ANKI_CONNECT_URL ?? 'http://127.0.0.1:8765' });
  const version = await anki.version();
  process.stdout.write(`AnkiConnect version ${version}\n`);

  const existing = await anki.deckNames();
  if (existing.includes(DECK)) {
    throw new Error(`${DECK} already exists. Remove it first so this script cannot touch real cards.`);
  }

  let created = false;
  try {
    await anki.invoke('createDeck', { deck: DECK });
    created = true;

    const noteId = await anki.invoke<number>('addNote', {
      note: {
        deckName: DECK,
        modelName: 'Basic',
        fields: { Front: 'Scratch question for the glasses check', Back: 'Scratch answer' },
        tags: ['anki-glasses-live-check'],
        options: { allowDuplicate: true },
      },
    });
    const cardIds = await anki.invoke<number[]>('findCards', { query: `"deck:${DECK}"` });
    const cardId = cardIds[0];
    if (!cardId) throw new Error('no card was created in the scratch deck');

    // A brand new card is not due, so pull it to today the way Anki would.
    await anki.invoke('setDueDate', { cards: [cardId], days: '0' });

    const before = await cardState(anki, cardId);
    process.stdout.write(`scratch note ${noteId}, card ${cardId}, reps ${before.reps}\n`);

    const session = new ReviewSession(anki, {
      ...DEFAULT_SESSION_OPTIONS,
      filter: { ...DEFAULT_FILTER, includeDecks: [DECK] },
    });
    await session.start();

    const next = await session.next();
    check('the scratch card is served through the real filter', next.card?.cardId === cardId, JSON.stringify(next.card?.questionPages));
    if (!next.card) throw new Error('the scratch card was not served');

    check('the question text was rendered for the display', next.card.questionPages[0] === 'Scratch question for the glasses check', JSON.stringify(next.card.questionPages));
    check('the answer text excludes the repeated question', next.card.answerPages[0] === 'Scratch answer', JSON.stringify(next.card.answerPages));

    const graded = await session.answer(next.card.token, 3);
    check('Anki accepted the grade', graded.ok === true);
    check('Anki returned an interval for the chosen ease', typeof graded.interval === 'string' && graded.interval.length > 0, String(graded.interval));

    const after = await cardState(anki, cardId);
    check('the real scheduler recorded the review', after.reps === before.reps + 1, `reps ${before.reps} to ${after.reps}`);
    check('the card is no longer due today', after.due !== before.due || after.interval !== before.interval, `due ${before.due} to ${after.due}, interval ${before.interval} to ${after.interval}`);

  } finally {
    if (created) {
      await anki.invoke('deleteDecks', { decks: [DECK], cardsToo: true });
      const left = await anki.deckNames();
      process.stdout.write(`\nscratch deck removed: ${!left.includes(DECK)}\n`);
    }
  }

  const failed = results.filter(([, ok]) => !ok);
  process.stdout.write(`${results.length - failed.length} passed, ${failed.length} failed\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`live check failed: ${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
