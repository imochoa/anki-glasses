import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DEFAULT_CONFIG } from '../src/server/config.js';
import { ACCESS_HEADER, startServer, type ServerHandle } from '../src/server/index.js';
import { decksToExclude } from '../src/server/report.js';
import { defaultCards, startMockAnki, type MockAnki } from '../tools/mock-anki.js';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('http server', () => {
  let mock: MockAnki;
  let server: ServerHandle;
  let base: string;

  before(async () => {
    mock = await startMockAnki();
    server = await startServer({
      ...DEFAULT_CONFIG,
      ankiConnectUrl: mock.url,
      host: '127.0.0.1',
      port: 8713,
      accessKey: 'test-key-that-is-long-enough',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    await mock.close();
  });

  const withKey = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', [ACCESS_HEADER]: server.accessKey, ...(init.headers ?? {}) },
    });

  it('refuses collection endpoints without the key', async () => {
    for (const path of ['/api/session/next', '/api/config', '/api/report']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, `${path} must not be open`);
    }
  });

  it('refuses a wrong key', async () => {
    const response = await fetch(`${base}/api/session/next`, {
      headers: { [ACCESS_HEADER]: 'not-the-key-but-same-length-xx' },
    });
    assert.equal(response.status, 401);
  });

  it('refuses to grade without the key, so no unauthenticated write is possible', async () => {
    const before = mock.answers.length;
    const response = await fetch(`${base}/api/session/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'anything', ease: 1 }),
    });
    assert.equal(response.status, 401);
    assert.equal(mock.answers.length, before, 'an unauthenticated request reached Anki');
  });

  it('accepts the key in the query string, which is how the phone gets it', async () => {
    const response = await fetch(`${base}/api/config?k=${encodeURIComponent(server.accessKey)}`);
    assert.equal(response.status, 200);
  });

  it('leaves the health endpoint open but says nothing about the collection', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['ankiConnect', 'ok']);
  });

  it('does not hand out a wildcard cross origin permission', async () => {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('serves a card through the api once the key is supplied', async () => {
    const started = await withKey('/api/session/start', { method: 'POST', body: '{}' });
    assert.equal(started.status, 200);
    const next = await (await withKey('/api/session/next')).json();
    assert.equal(next.done, false);
    assert.ok(next.card.token);
    mock.answers.length = 0;
  });

  it('keeps the running session when a second client starts one', async () => {
    // A reloaded WebView, or a second phone holding the same pairing url,
    // would otherwise replace the session that issued the token the wearer is
    // about to grade with, and that grade would be lost in silence.
    await withKey('/api/session/start', { method: 'POST', body: '{}' });
    const first = await (await withKey('/api/session/next')).json();
    assert.ok(first.card?.token);

    const second = await (
      await withKey('/api/session/start', { method: 'POST', body: '{}' })
    ).json();
    assert.equal(second.sessionId, first.state.sessionId, 'the session was replaced');

    const graded = await (
      await withKey('/api/session/answer', {
        method: 'POST',
        body: JSON.stringify({ token: first.card.token, ease: 3 }),
      })
    ).json();
    assert.equal(graded.outcome, 'graded');
    assert.equal(mock.answers.at(-1)?.cardId, first.card.cardId);
    mock.answers.length = 0;
  });

  it('rejects an answer that is not a valid ease', async () => {
    const response = await withKey('/api/session/answer', {
      method: 'POST',
      body: JSON.stringify({ token: 'x', ease: 9 }),
    });
    assert.equal(response.status, 400);
  });
});

describe('picking a deck', () => {
  let mock: MockAnki;
  let server: ServerHandle;
  let base: string;

  before(async () => {
    // Two trees: the default Demo cards, with the first three moved to Other.
    const cards = defaultCards().map((card, index) =>
      index < 3 ? { ...card, deckName: 'Other' } : card,
    );
    mock = await startMockAnki(cards);
    server = await startServer({
      ...DEFAULT_CONFIG,
      ankiConnectUrl: mock.url,
      host: '127.0.0.1',
      port: 8715,
      accessKey: 'test-key-that-is-long-enough',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    await mock.close();
  });

  const withKey = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', [ACCESS_HEADER]: server.accessKey, ...(init.headers ?? {}) },
    });

  const start = (deck: unknown) =>
    withKey('/api/session/start', { method: 'POST', body: JSON.stringify({ deck }) });

  it('refuses the deck list without the key', async () => {
    assert.equal((await fetch(`${base}/api/decks`)).status, 401);
  });

  it('lists the top level trees alphabetically, without subdecks', async () => {
    const body = await (await withKey('/api/decks')).json();
    assert.deepEqual(
      body.decks.map((deck: { name: string }) => deck.name),
      ['Demo', 'Other'],
    );
    for (const deck of body.decks) assert.equal(typeof deck.due, 'number');
  });

  it('serves only cards from the picked deck', async () => {
    const started = await (await start('Other')).json();
    assert.equal(started.deck, 'Other');
    const next = await (await withKey('/api/session/next')).json();
    assert.equal(next.done, false);
    assert.equal(next.card.deck, 'Other');
  });

  it('resumes the same deck but replaces the session for a different one', async () => {
    const first = await (await start('Other')).json();
    const again = await (await start('Other')).json();
    assert.equal(again.sessionId, first.sessionId, 'the same deck should resume');

    const switched = await (await start('Demo')).json();
    assert.notEqual(switched.sessionId, first.sessionId, 'a new deck should start fresh');
    assert.equal(switched.deck, 'Demo');
    const next = await (await withKey('/api/session/next')).json();
    assert.match(next.card.deck, /^Demo(::|$)/);
  });

  it('does not grade a card shown before the wearer switched decks', async () => {
    await start('Other');
    const shown = await (await withKey('/api/session/next')).json();
    await start('Demo');
    const before = mock.answers.length;
    const result = await (
      await withKey('/api/session/answer', {
        method: 'POST',
        body: JSON.stringify({ token: shown.card.token, ease: 3 }),
      })
    ).json();
    assert.equal(result.outcome, 'unknown-token');
    assert.equal(mock.answers.length, before, 'a stale token reached Anki');
  });

  it('refuses a deck that is not a name', async () => {
    assert.equal((await start(42)).status, 400);
  });
});

describe('a picked deck still obeys the configured filter', () => {
  let mock: MockAnki;
  let server: ServerHandle;

  before(async () => {
    mock = await startMockAnki();
    server = await startServer({
      ...DEFAULT_CONFIG,
      ankiConnectUrl: mock.url,
      host: '127.0.0.1',
      port: 8716,
      accessKey: 'test-key-that-is-long-enough',
      filter: { ...DEFAULT_CONFIG.filter, excludeDecks: ['Demo::Sub'] },
    });
  });

  after(async () => {
    await server.close();
    await mock.close();
  });

  it('refuses to start an excluded deck', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ACCESS_HEADER]: server.accessKey },
      body: JSON.stringify({ deck: 'Demo::Sub' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'bad-deck');
  });
});

describe('the built server serves the built app', () => {
  const entry = resolve('dist/server/server/index.js');
  const app = resolve('dist/app/index.html');

  it('finds dist/app with no static root override', async (t) => {
    if (!existsSync(entry) || !existsSync(app)) {
      t.skip('run npm run build first');
      return;
    }
    const mock = await startMockAnki();
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ANKI_CONNECT_URL: mock.url,
        ANKI_GLASSES_PORT: '8714',
        ANKI_GLASSES_KEY: 'test-key-that-is-long-enough',
      },
      stdio: 'ignore',
    });

    try {
      let body = '';
      let status = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(150);
        try {
          const response = await fetch('http://127.0.0.1:8714/');
          status = response.status;
          body = await response.text();
          break;
        } catch {
          // still starting
        }
      }
      assert.equal(status, 200, 'the started server did not serve the app');
      assert.match(body, /<script type="module"/, 'index.html was not returned');
    } finally {
      child.kill('SIGKILL');
      await mock.close();
    }
  });
});

describe('automatic deck exclusions from the report', () => {
  const deck = (name: string, due: number, reviewable: number) => ({
    deck: name,
    due,
    reviewable,
    skipped: due - reviewable,
    skippedByReason: {},
    excluded: false,
  });

  it('excludes a deck that is mostly pictures', () => {
    assert.deepEqual(decksToExclude([deck('Art', 50, 2)], 20), ['Art']);
  });

  it('does not exclude a parent whose subdeck is worth keeping', () => {
    // An exclusion covers everything under the deck, so excluding P for its
    // own ten pictures would also hide the hundred readable cards in P::Text.
    assert.deepEqual(decksToExclude([deck('P', 10, 0), deck('P::Text', 100, 100)], 20), []);
  });

  it('does not exclude a parent whose subdeck merely has nothing due today', () => {
    // The exclusion outlives today's due list. A readable subdeck reviewed
    // this morning would otherwise be hidden from tomorrow onwards.
    assert.deepEqual(decksToExclude([deck('P', 10, 0), deck('P::Text', 0, 0)], 20), []);
  });

  it('still excludes a parent when everything under it is unusable too', () => {
    assert.deepEqual(decksToExclude([deck('P', 10, 0), deck('P::Pics', 30, 1)], 20), [
      'P',
      'P::Pics',
    ]);
  });

  it('leaves a small deck alone even when it is unusable', () => {
    assert.deepEqual(decksToExclude([deck('Tiny', 5, 0)], 20), []);
  });
});
