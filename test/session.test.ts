import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AnkiClient } from '../src/server/ankiconnect.js';
import { DEFAULT_SESSION_OPTIONS, ReviewSession, rootDecks } from '../src/server/session.js';
import { DEFAULT_FILTER } from '../src/core/suitability.js';
import { startMockAnki, type MockAnki } from '../tools/mock-anki.js';

describe('rootDecks', () => {
  it('collapses subdecks into their tree', () => {
    assert.deepEqual(rootDecks(['A', 'A::B', 'A::B::C', 'D']), ['A', 'D']);
  });

  it('keeps a similarly named deck separate', () => {
    assert.deepEqual(rootDecks(['A', 'A Extra']).sort(), ['A', 'A Extra']);
  });
});

describe('review session against a mock collection', () => {
  let mock: MockAnki;

  // A fresh collection per test: grading a card in the mock leaves it no
  // longer due, exactly as in Anki, so tests cannot inherit each other's work.
  beforeEach(async () => {
    mock = await startMockAnki();
  });

  afterEach(async () => {
    await mock.close();
  });

  const makeSession = () =>
    new ReviewSession(new AnkiClient({ url: mock.url }), {
      ...DEFAULT_SESSION_OPTIONS,
      filter: DEFAULT_FILTER,
    });

  it('serves only cards the glasses can show, and never grades the rest', async () => {
    const session = makeSession();
    await session.start();

    const servedIds: number[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const next = await session.next();
      if (next.done || !next.card) break;
      servedIds.push(next.card.cardId);
      await session.answer(next.card.token, 3);
    }

    // Learning card first, then the overdue one, then the rest by id.
    assert.deepEqual(servedIds, [1005, 1011, 1001, 1008]);

    const graded = mock.answers.map((entry) => entry.cardId);
    assert.deepEqual(graded, servedIds, 'only served cards may be graded');
    for (const skipped of [1002, 1003, 1004, 1006, 1007, 1010]) {
      assert.ok(!graded.includes(skipped), `card ${skipped} must not be graded`);
    }

    const state = session.state();
    assert.equal(state.answered, 4);
    assert.equal(state.counts.skippedByReason.image, 1);
    assert.equal(state.counts.skippedByReason.media, 1);
    assert.equal(state.counts.skippedByReason['too-long'], 1);
    assert.equal(state.counts.skippedByReason.table, 1);
    assert.equal(state.counts.skippedByReason.math, 1);
    assert.equal(state.counts.skippedByReason['tag-excluded'], 1);

    mock.answers.length = 0;
  });

  it('does not serve both cards of the same note', async () => {
    const session = makeSession();
    await session.start();
    const seen: number[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const next = await session.next();
      if (next.done || !next.card) break;
      seen.push(next.card.noteId);
      await session.answer(next.card.token, 3);
    }
    assert.equal(new Set(seen).size, seen.length, 'a note was reviewed twice');
    mock.answers.length = 0;
  });

  it('grades a card exactly once even if the same token arrives twice', async () => {
    const session = makeSession();
    await session.start();
    const first = await session.next();
    assert.ok(first.card);

    const token = first.card.token;
    const one = await session.answer(token, 4);
    const two = await session.answer(token, 1);

    assert.equal(one.ok, true);
    assert.equal(two.outcome, 'duplicate');
    assert.equal(mock.answers.length, 1, 'the repeated token must not reach Anki');
    assert.deepEqual(mock.answers[0], { cardId: 1005, ease: 4 });
    mock.answers.length = 0;
  });

  it('passes the chosen ease through to Anki unchanged', async () => {
    const session = makeSession();
    await session.start();
    for (const ease of [1, 2, 3, 4] as const) {
      const next = await session.next();
      if (next.done || !next.card) break;
      await session.answer(next.card.token, ease);
    }
    assert.deepEqual(
      mock.answers.map((entry) => entry.ease),
      [1, 2, 3, 4],
    );
    mock.answers.length = 0;
  });

  it('reports the interval label with the bidi isolates removed', async () => {
    const session = makeSession();
    await session.start();
    const next = await session.next();
    assert.ok(next.card);
    const result = await session.answer(next.card.token, 3);
    assert.equal(result.interval, '4d');
    mock.answers.length = 0;
  });

  it('finishes cleanly when no card passes the filter', async () => {
    const onlyImages = await startMockAnki([
      {
        cardId: 2001,
        note: 2001,
        deckName: 'Pictures',
        modelName: 'Basic',
        question: '<img src=a.png>',
        answer: '<hr id=answer>Answer',
        tags: [],
        isLearn: false,
        overdue: false,
      },
    ]);
    try {
      const session = new ReviewSession(new AnkiClient({ url: onlyImages.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const next = await session.next();
      assert.equal(next.done, true);
      assert.equal(next.card, undefined);
      assert.equal(onlyImages.answers.length, 0);
      assert.equal(next.state.counts.skippedByReason.image, 1);
    } finally {
      await onlyImages.close();
    }
  });

  it('handles an empty collection without throwing', async () => {
    const empty = await startMockAnki([]);
    try {
      const session = new ReviewSession(new AnkiClient({ url: empty.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      const state = await session.start();
      assert.equal(state.counts.due, 0);
      assert.equal((await session.next()).done, true);
    } finally {
      await empty.close();
    }
  });

  it('serves the same card until it is graded, so next is safe to repeat', async () => {
    const session = makeSession();
    await session.start();
    const a = await session.next();
    const b = await session.next();
    assert.equal(a.card?.cardId, b.card?.cardId);
    assert.equal(a.card?.token, b.card?.token);
    mock.answers.length = 0;
  });
});

describe('daily limits', () => {
  it('does not let unreadable cards consume the daily allowance', async () => {
    // Anki says only two reviews are left today. The first cards in the queue
    // are pictures. Spending the allowance on them would end the session while
    // readable cards are still due.
    const cards = [
      { cardId: 3001, note: 3001, deckName: 'Mixed', modelName: 'Basic', question: '<img src=a.png>', answer: '<hr id=answer>A', tags: [], isLearn: false, overdue: false },
      { cardId: 3002, note: 3002, deckName: 'Mixed', modelName: 'Basic', question: '<img src=b.png>', answer: '<hr id=answer>B', tags: [], isLearn: false, overdue: false },
      { cardId: 3003, note: 3003, deckName: 'Mixed', modelName: 'Basic', question: 'Readable question', answer: '<hr id=answer>Readable answer', tags: [], isLearn: false, overdue: false },
      { cardId: 3004, note: 3004, deckName: 'Mixed', modelName: 'Basic', question: 'Second readable', answer: '<hr id=answer>Second answer', tags: [], isLearn: false, overdue: false },
      { cardId: 3005, note: 3005, deckName: 'Mixed', modelName: 'Basic', question: 'Third readable', answer: '<hr id=answer>Third answer', tags: [], isLearn: false, overdue: false },
    ];
    const mock = await startMockAnki(cards, { limits: { reviewCount: 2, learnCount: 0 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();

      const served: number[] = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const next = await session.next();
        if (next.done || !next.card) break;
        served.push(next.card.cardId);
        await session.answer(next.card.token, 3);
      }

      assert.deepEqual(served, [3003, 3004], 'the allowance should be spent on readable cards');
      assert.equal(session.state().counts.dailyAllowance, 2);
    } finally {
      await mock.close();
    }
  });

  it('still stops at the allowance once it is spent', async () => {
    const cards = Array.from({ length: 6 }, (_, index) => ({
      cardId: 4001 + index,
      note: 4001 + index,
      deckName: 'Plenty',
      modelName: 'Basic',
      question: `Question ${index}`,
      answer: `<hr id=answer>Answer ${index}`,
      tags: [],
      isLearn: false,
      overdue: false,
    }));
    const mock = await startMockAnki(cards, { limits: { reviewCount: 3, learnCount: 0 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      let served = 0;
      for (let guard = 0; guard < 10; guard += 1) {
        const next = await session.next();
        if (next.done || !next.card) break;
        served += 1;
        await session.answer(next.card.token, 3);
      }
      assert.equal(served, 3, 'the daily allowance must still be respected');
      assert.equal(mock.answers.length, 3);
    } finally {
      await mock.close();
    }
  });
});

describe('recovering from a failed grade', () => {
  it('lets the card be graded again when the grade did not reach Anki', async () => {
    const mock = await startMockAnki();
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url, timeoutMs: 4000 }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const first = await session.next();
      assert.ok(first.card);
      const token = first.card.token;

      mock.failNextAnswer = 'drop';
      await assert.rejects(() => session.answer(token, 3));
      assert.equal(mock.answers.length, 0, 'nothing should have been recorded');

      // The same card is still current, and the retry has to work. Leaving the
      // token consumed here would strand the card for the whole session.
      const again = await session.next();
      assert.equal(again.card?.cardId, first.card.cardId);
      const retry = await session.answer(again.card!.token, 3);
      assert.equal(retry.ok, true);
      assert.equal(retry.outcome, 'graded');
      assert.equal(mock.answers.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('does not grade twice when the failure happened after Anki applied it', async () => {
    const mock = await startMockAnki();
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url, timeoutMs: 4000 }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const first = await session.next();
      assert.ok(first.card);

      mock.failNextAnswer = 'apply-then-fail';
      const result = await session.answer(first.card.token, 3);

      assert.equal(result.ok, true, 'the grade landed, so it counts as applied');
      assert.equal(mock.answers.length, 1);
      const next = await session.next();
      assert.notEqual(next.card?.cardId, first.card.cardId, 'it should move on');
      assert.equal(mock.answers.length, 1, 'the card must not be graded a second time');
    } finally {
      await mock.close();
    }
  });
});

describe('cards handled somewhere else while the glasses session is open', () => {
  const plain = (cardId: number, extra: Partial<Record<string, unknown>> = {}) => ({
    cardId,
    note: cardId,
    deckName: 'Desk',
    modelName: 'Basic',
    question: `Question ${cardId}`,
    answer: `<hr id=answer>Answer ${cardId}`,
    tags: [] as string[],
    isLearn: false,
    overdue: false,
    ...extra,
  });

  it('does not grade a card that was reviewed on the desktop after it was shown', async () => {
    // Anki stays open on the desktop for the whole glasses run, so the due
    // list this session snapshotted goes stale under it.
    const mock = await startMockAnki([plain(5001), plain(5002)]);
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const shown = await session.next();
      assert.equal(shown.card?.cardId, 5001);

      // The wearer reads the answer. Meanwhile the same card is reviewed on
      // the desktop. Only then does the gesture arrive.
      mock.markNotDue(5001);
      const result = await session.answer(shown.card!.token, 3);

      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'not-due');
      assert.deepEqual(mock.answers, [], 'a second review must not be recorded');
      assert.equal(result.next.card?.cardId, 5002, 'the session moves on');
    } finally {
      await mock.close();
    }
  });

  it('does not show a card that stopped being due before it reached the queue', async () => {
    const mock = await startMockAnki([plain(5101), plain(5102)]);
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      mock.markNotDue(5101);

      const shown = await session.next();
      assert.equal(shown.card?.cardId, 5102, 'the buried card should never be shown');
    } finally {
      await mock.close();
    }
  });

  it('tells the wearer when a token is not from the running session', async () => {
    const mock = await startMockAnki([plain(5201)]);
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      await session.next();

      const result = await session.answer('a token from another session', 3);
      assert.equal(result.outcome, 'unknown-token');
      assert.deepEqual(mock.answers, []);
    } finally {
      await mock.close();
    }
  });
});

describe('stopping when the day\u2019s allowance is spent', () => {
  it('does not walk the rest of the due list once no deck has allowance left', async () => {
    // The allowance is one card and 200 more are due. Grading that card must
    // not leave the wearer staring at it while the session reads the rest.
    const cards = Array.from({ length: 200 }, (_, index) => ({
      cardId: 6001 + index,
      note: 6001 + index,
      deckName: 'Big',
      modelName: 'Basic',
      question: `Question ${index}`,
      answer: `<hr id=answer>Answer ${index}`,
      tags: [] as string[],
      isLearn: false,
      overdue: false,
    }));
    const mock = await startMockAnki(cards, { limits: { reviewCount: 1, learnCount: 0 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const shown = await session.next();
      assert.equal(shown.card?.cardId, 6001);

      mock.calls.length = 0;
      const result = await session.answer(shown.card!.token, 3);

      assert.equal(result.next.done, true, 'the session is over once the allowance is spent');
      assert.equal(
        mock.calls.filter((action) => action === 'cardsInfo').length,
        0,
        'no card html should be fetched after the allowance is spent',
      );
    } finally {
      await mock.close();
    }
  });

  it('does not let a skipped learning card pay for an extra review', async () => {
    // Anki allows five learning cards and no reviews. Every learning card is a
    // picture, so none can be shown. That must not turn into review capacity.
    const cards = [
      ...Array.from({ length: 5 }, (_, index) => ({
        cardId: 7001 + index,
        note: 7001 + index,
        deckName: 'Split',
        modelName: 'Basic',
        question: `<img src="pic${index}.png">`,
        answer: '<hr id=answer>A picture',
        tags: [] as string[],
        isLearn: true,
        overdue: false,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        cardId: 7101 + index,
        note: 7101 + index,
        deckName: 'Split',
        modelName: 'Basic',
        question: `Readable ${index}`,
        answer: `<hr id=answer>Answer ${index}`,
        tags: [] as string[],
        isLearn: false,
        overdue: false,
      })),
    ];
    const mock = await startMockAnki(cards, { limits: { learnCount: 5, reviewCount: 0 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();

      const served: number[] = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const next = await session.next();
        if (next.done || !next.card) break;
        served.push(next.card.cardId);
        await session.answer(next.card.token, 3);
      }

      assert.deepEqual(served, [], 'no review allowance means no reviews');
      assert.deepEqual(mock.answers, []);
    } finally {
      await mock.close();
    }
  });

  it('gives way to a fresh session once the allowance is gone', async () => {
    // Resuming has to stop where the session really stopped. Otherwise the
    // wearer who raises a deck limit and restarts the app sees the finished
    // session forever.
    const cards = Array.from({ length: 3 }, (_, index) => ({
      cardId: 7301 + index,
      note: 7301 + index,
      deckName: 'Split',
      modelName: 'Basic',
      question: `Readable ${index}`,
      answer: `<hr id=answer>Answer ${index}`,
      tags: [] as string[],
      isLearn: false,
      overdue: false,
    }));
    const mock = await startMockAnki(cards, { limits: { learnCount: 0, reviewCount: 1 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      assert.equal(session.isActive(), true);

      const shown = await session.next();
      await session.answer(shown.card!.token, 3);

      assert.equal((await session.next()).done, true);
      assert.equal(session.isActive(), false, 'a spent session must not be resumed');
    } finally {
      await mock.close();
    }
  });

  it('keeps a session with a card on screen resumable', async () => {
    const cards = [
      {
        cardId: 7401,
        note: 7401,
        deckName: 'Split',
        modelName: 'Basic',
        question: 'Readable',
        answer: '<hr id=answer>Answer',
        tags: [] as string[],
        isLearn: false,
        overdue: false,
      },
    ];
    const mock = await startMockAnki(cards, { limits: { learnCount: 0, reviewCount: 1 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      await session.next();
      // The allowance is already spent on the card the wearer is looking at.
      assert.equal(session.isActive(), true, 'the card on screen still needs grading');
    } finally {
      await mock.close();
    }
  });

  it('spends the review allowance when the learning allowance is gone', async () => {
    const cards = Array.from({ length: 4 }, (_, index) => ({
      cardId: 7201 + index,
      note: 7201 + index,
      deckName: 'Split',
      modelName: 'Basic',
      question: `Readable ${index}`,
      answer: `<hr id=answer>Answer ${index}`,
      tags: [] as string[],
      isLearn: false,
      overdue: false,
    }));
    const mock = await startMockAnki(cards, { limits: { learnCount: 0, reviewCount: 2 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();

      const served: number[] = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const next = await session.next();
        if (next.done || !next.card) break;
        served.push(next.card.cardId);
        await session.answer(next.card.token, 3);
      }

      assert.deepEqual(served, [7201, 7202]);
    } finally {
      await mock.close();
    }
  });
});

describe('the queue after the buffer has already been filled', () => {
  const readable = (cardId: number, extra: Record<string, unknown> = {}) => ({
    cardId,
    note: cardId,
    deckName: 'Late',
    modelName: 'Basic',
    question: `Question ${cardId}`,
    answer: `<hr id=answer>Answer ${cardId}`,
    tags: [] as string[],
    isLearn: false,
    overdue: false,
    ...extra,
  });

  it('does not let a card buried after it was buffered take an allowance slot', async () => {
    // The whole due list is fetched in batches, so a card can go stale while
    // it sits in the buffer waiting its turn. Serving it anyway would spend
    // the last review Anki allowed on a card nobody can grade.
    const mock = await startMockAnki([readable(8001), readable(8002), readable(8003)], {
      limits: { learnCount: 0, reviewCount: 2 },
    });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const first = await session.next();
      assert.equal(first.card?.cardId, 8001, 'all three are now buffered');

      // Reviewed on the desktop while the wearer was reading the first card.
      mock.markNotDue(8002);
      const result = await session.answer(first.card!.token, 3);

      assert.equal(result.next.card?.cardId, 8003, 'the stale card must be skipped');
      await session.answer(result.next.card!.token, 3);
      assert.deepEqual(
        mock.answers.map((entry) => entry.cardId),
        [8001, 8003],
      );
    } finally {
      await mock.close();
    }
  });

  it('does not drag the review tail through the filter for an unspendable learning allowance', async () => {
    // Anki allows one learning card and one review. The only learning card is
    // a picture, so that allowance can never be spent. The session must not
    // keep the tree open and read every remaining review because of it.
    const cards = [
      {
        cardId: 8100,
        note: 8100,
        deckName: 'Late',
        modelName: 'Basic',
        question: '<img src="a.png">',
        answer: '<hr id=answer>A picture',
        tags: [] as string[],
        isLearn: true,
        overdue: false,
      },
      ...Array.from({ length: 200 }, (_, index) => readable(8201 + index)),
    ];
    const mock = await startMockAnki(cards, { limits: { learnCount: 1, reviewCount: 1 } });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const shown = await session.next();
      assert.equal(shown.card?.cardId, 8201, 'the picture is skipped, the review is served');

      mock.calls.length = 0;
      const result = await session.answer(shown.card!.token, 3);

      assert.equal(result.next.done, true);
      assert.equal(
        mock.calls.filter((action) => action === 'cardsInfo').length,
        0,
        'no more card html should be fetched once nothing can be spent',
      );
    } finally {
      await mock.close();
    }
  });
});

describe('a grade whose outcome Anki cannot confirm', () => {
  const learningCard = {
    cardId: 8301,
    note: 8301,
    deckName: 'Unsettled',
    modelName: 'Basic',
    question: 'Question',
    answer: '<hr id=answer>Answer',
    tags: [] as string[],
    isLearn: true,
    overdue: false,
  };

  const makeSession = (mock: MockAnki) =>
    new ReviewSession(new AnkiClient({ url: mock.url }), {
      ...DEFAULT_SESSION_OPTIONS,
      filter: DEFAULT_FILTER,
    });

  it('does not grade twice when the write landed but the check also failed', async () => {
    // Anki went away between applying the grade and answering the question of
    // whether it applied it. Reading that silence as a failure would release
    // the token, and a learning card comes round again a minute later.
    const mock = await startMockAnki([{ ...learningCard }]);
    try {
      const session = makeSession(mock);
      await session.start();
      const shown = await session.next();

      mock.failNextAnswer = 'apply-then-fail';
      mock.failNextCardsInfo = true;
      await assert.rejects(session.answer(shown.card!.token, 3));
      assert.equal(mock.answers.length, 1, 'the write did land');

      // Anki is back. The wearer tries the same card again.
      const again = await session.next();
      assert.equal(again.card?.cardId, shown.card!.cardId);
      const retry = await session.answer(again.card!.token, 3);

      assert.equal(retry.outcome, 'duplicate');
      assert.equal(mock.answers.length, 1, 'the card must not be graded twice');
    } finally {
      await mock.close();
    }
  });

  it('still grades the card when the write did not land', async () => {
    const mock = await startMockAnki([{ ...learningCard }]);
    try {
      const session = makeSession(mock);
      await session.start();
      const shown = await session.next();

      mock.failNextAnswer = 'drop';
      mock.failNextCardsInfo = true;
      await assert.rejects(session.answer(shown.card!.token, 3));
      assert.equal(mock.answers.length, 0, 'nothing was recorded');

      const again = await session.next();
      const retry = await session.answer(again.card!.token, 2);

      assert.equal(retry.ok, true);
      assert.deepEqual(mock.answers, [{ cardId: 8301, ease: 2 }]);
    } finally {
      await mock.close();
    }
  });
});

describe('a session with work pending', () => {
  it('counts as active while it is still starting, so a start cannot replace it', async () => {
    const mock = await startMockAnki();
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      // While start() is waiting on Anki there is no card, no buffer and no
      // candidate list yet, so an idle check that only looked at those would
      // let a second client's start replace the session under the first.
      const starting = session.start();
      await new Promise((done) => setImmediate(done));
      assert.equal(session.isActive(), true, 'a pending start must keep the session alive');
      await starting;
      const choosing = session.next();
      await new Promise((done) => setImmediate(done));
      assert.equal(session.isActive(), true, 'a pending next must keep the session alive');
      const next = await choosing;
      assert.ok(next.card);
    } finally {
      await mock.close();
    }
  });
});

describe('reads that fail while a card is being chosen', () => {
  const sessionFor = (mock: MockAnki) =>
    new ReviewSession(new AnkiClient({ url: mock.url }), {
      ...DEFAULT_SESSION_OPTIONS,
      filter: DEFAULT_FILTER,
    });

  it('asks for the same cards again after the fetch fails, instead of dropping them', async () => {
    const mock = await startMockAnki();
    try {
      const session = sessionFor(mock);
      await session.start();
      mock.failNextCardsInfo = true;
      await assert.rejects(session.next());
      assert.equal(session.isActive(), true, 'the session is still worth resuming');
      const next = await session.next();
      assert.equal(next.card?.cardId, 1005, 'the first card is still the learning card');
    } finally {
      await mock.close();
    }
  });

  it('keeps the card at the head of the queue when its due check fails', async () => {
    const mock = await startMockAnki();
    try {
      const session = sessionFor(mock);
      await session.start();
      mock.failNextFindCards = true;
      await assert.rejects(session.next());
      const next = await session.next();
      assert.equal(next.card?.cardId, 1005);
    } finally {
      await mock.close();
    }
  });
});

describe('a subdeck with its own daily limit', () => {
  it('is not served past that limit while the parent still has allowance', async () => {
    const plain = (cardId: number, deckName: string) => ({
      cardId,
      note: cardId,
      deckName,
      modelName: 'Basic',
      question: `Question ${cardId}`,
      answer: `<hr id=answer>Answer ${cardId}`,
      tags: [],
      isLearn: false,
      overdue: false,
    });
    // Anki reports the parent as having one review left, which is the child B
    // has. Child A's own limit is spent. Its card sorts first, so a session
    // that only checked the parent would serve it and exceed A's limit.
    const mock = await startMockAnki([plain(2001, 'P::A'), plain(2002, 'P::B')], {
      limitsByDeck: {
        P: { learnCount: 0, reviewCount: 1 },
        'P::A': { learnCount: 0, reviewCount: 0 },
        'P::B': { learnCount: 0, reviewCount: 1 },
      },
    });
    try {
      const session = new ReviewSession(new AnkiClient({ url: mock.url }), {
        ...DEFAULT_SESSION_OPTIONS,
        filter: DEFAULT_FILTER,
      });
      await session.start();
      const served: number[] = [];
      for (let guard = 0; guard < 5; guard += 1) {
        const next = await session.next();
        if (next.done || !next.card) break;
        served.push(next.card.cardId);
        await session.answer(next.card.token, 3);
      }
      assert.deepEqual(served, [2002]);
      assert.deepEqual(
        mock.answers.map((entry) => entry.cardId),
        [2002],
        'the card in the spent subdeck must not reach Anki',
      );
    } finally {
      await mock.close();
    }
  });
});
