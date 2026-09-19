/**
 * End to end run against the official Even Hub simulator.
 *
 * It boots a mock Anki, boots the real server, loads the real app in the
 * simulator, and drives it with the simulator's input API, which is the same
 * event path the R1 ring and the temple pad use. Every assertion is made
 * against what actually reached the glasses.
 *
 * Requires a display. On a headless box run Xvfb first and export DISPLAY.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { DEFAULT_CONFIG } from '../../src/server/config.js';
import { startServer } from '../../src/server/index.js';
import { startMockAnki, type MockAnki } from '../../tools/mock-anki.js';
import { decodePng, differenceRatio, inkRatio, type Bitmap } from './png.js';

/** The card body area of the display, matching the layout in glasses.ts. */
const BODY_REGION = { x: 0, y: 36, width: 576, height: 206 };
const BASELINES = resolve('test/e2e/baseline');
const UPDATE_BASELINES = process.env.E2E_UPDATE_BASELINE === '1';

const APP_PORT = Number.parseInt(process.env.E2E_APP_PORT ?? '8711', 10);
const SIM_PORT = Number.parseInt(process.env.E2E_SIM_PORT ?? '9899', 10);
const SHOTS = resolve('test/e2e/screenshots');

type SimAction =
  | 'up'
  | 'down'
  | 'click'
  | 'double_click'
  | 'long_press'
  | 'long_press_release'
  | 'context_menu';

interface ConsoleEntry {
  id: number;
  level: string;
  message: string;
  ts: number;
}

const failures: string[] = [];
const checks: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    checks.push(name);
    process.stdout.write(`  pass  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? `: ${detail}` : ''}\n`);
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function simulatorBinary(): string {
  const require = createRequire(import.meta.url);
  const platform = process.platform;
  const arch = process.arch;
  const name = platform === 'win32' ? 'evenhub-simulator.exe' : 'evenhub-simulator';
  return require.resolve(`@evenrealities/sim-${platform}-${arch}/bin/${name}`);
}

class Simulator {
  private cursor = -1;
  readonly transcript: ConsoleEntry[] = [];

  constructor(
    private readonly process: ChildProcess,
    private readonly port: number,
  ) {}

  private base(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async ready(timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const response = await fetch(this.base('/api/ping'), {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error('simulator automation API never came up');
      await sleep(500);
    }
  }

  async pump(): Promise<ConsoleEntry[]> {
    // since_id is unsigned, so the first poll asks for everything buffered.
    const path = this.cursor < 0 ? '/api/console' : `/api/console?since_id=${this.cursor}`;
    const response = await fetch(this.base(path), { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    if (!response.ok) throw new Error(`console poll failed ${response.status}: ${body.slice(0, 120)}`);
    const payload = JSON.parse(body) as { entries: ConsoleEntry[] };
    const fresh = payload.entries ?? [];
    for (const entry of fresh) {
      this.cursor = Math.max(this.cursor, entry.id);
      this.transcript.push(entry);
    }
    return fresh;
  }

  /** Index to pass to waitFor so it only considers lines logged after now. */
  mark(): number {
    return this.transcript.length;
  }

  /**
   * Wait for a console line matching a pattern. Searches the accumulated
   * transcript from `since`, because a poll can return several lines at once
   * and the interesting one is easy to miss if only fresh lines are scanned.
   */
  async waitFor(pattern: RegExp, since = 0, timeoutMs = 20000): Promise<ConsoleEntry> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.pump();
      const hit = this.transcript.slice(since).find((entry) => pattern.test(entry.message));
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${pattern}. Last lines:\n${this.transcript
            .slice(-12)
            .map((entry) => `  ${entry.message}`)
            .join('\n')}`,
        );
      }
      await sleep(250);
    }
  }

  async input(action: SimAction): Promise<void> {
    const response = await fetch(this.base('/api/input'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`input ${action} failed with ${response.status}`);
  }

  async bitmap(name: string): Promise<Bitmap> {
    return decodePng(await this.screenshot(name));
  }

  async screenshot(name: string): Promise<Buffer> {
    const bytes = await this.capture();
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(resolve(SHOTS, `${name}.png`), bytes);
    return bytes;
  }

  private async capture(): Promise<Buffer> {
    const response = await fetch(this.base('/api/screenshot/glasses'), {
      signal: AbortSignal.timeout(10000),
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Capture once the display has stopped changing.
   *
   * The app logs a frame when the sdk call resolves, but the simulator paints
   * the glasses framebuffer on its own schedule, so a capture taken the moment
   * that log appears can catch a half drawn body and fail a baseline that is
   * actually correct. Two identical captures in a row mean the paint finished.
   */
  async settled(name: string, timeoutMs = 8000): Promise<{ png: Buffer; bitmap: Bitmap }> {
    const deadline = Date.now() + timeoutMs;
    let previous = decodePng(await this.capture());
    for (;;) {
      await new Promise((done) => setTimeout(done, 150));
      const png = await this.capture();
      const bitmap = decodePng(png);
      const settled = differenceRatio(previous, bitmap, BODY_REGION) === 0;
      previous = bitmap;
      if (settled || Date.now() > deadline) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(resolve(SHOTS, `${name}.png`), png);
        check(`the display settled before ${name} was captured`, settled, 'still repainting at the deadline');
        return { png, bitmap };
      }
    }
  }

  stop(): void {
    this.process.kill('SIGKILL');
  }
}

function parseFrame(entry: ConsoleEntry): Record<string, string> | null {
  if (!entry.message.startsWith('frame ')) return null;
  try {
    return JSON.parse(entry.message.slice('frame '.length)) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Compare the rendered body area against a committed baseline image, so the
 * assertion is about pixels the wearer would see rather than about what the
 * app said it was going to draw. Refresh with E2E_UPDATE_BASELINE=1 when the
 * simulator or the fixture text changes on purpose.
 */
function checkAgainstBaseline(name: string, actual: Bitmap, actualPng: Buffer): void {
  mkdirSync(BASELINES, { recursive: true });
  const path = resolve(BASELINES, `${name}.png`);
  if (UPDATE_BASELINES) {
    writeFileSync(path, actualPng);
    check(`baseline ${name} written`, true, 'baseline refreshed on request');
    return;
  }
  if (!existsSync(path)) {
    // Creating the baseline here would make the run its own expectation, so a
    // missing baseline has to fail rather than quietly approve the output.
    check(
      `baseline exists for ${name}`,
      false,
      `no baseline at ${path}. Create it deliberately with E2E_UPDATE_BASELINE=1`,
    );
    return;
  }
  const expected = decodePng(readFileSync(path));
  const drift = differenceRatio(expected, actual, BODY_REGION);
  check(
    `rendered body matches the committed baseline for ${name}`,
    // Text covers well under one percent of the body area, so the tolerance
    // has to be far tighter than that to notice a changed word.
    drift < 0.0005,
    `${(drift * 100).toFixed(3)} percent of body pixels differ`,
  );
}

/** The most recent frame the app reported drawing. */
function lastFrame(entries: ConsoleEntry[]): Record<string, string> | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i].message;
    if (message.startsWith('frame ')) {
      try {
        return JSON.parse(message.slice('frame '.length)) as Record<string, string>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!process.env.DISPLAY && process.platform === 'linux') {
    throw new Error('DISPLAY is not set. Start Xvfb and export DISPLAY, for example :77');
  }

  let mock: MockAnki | null = null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let sim: Simulator | null = null;

  try {
    mock = await startMockAnki();
    process.stdout.write(`mock anki on ${mock.url}\n`);

    server = await startServer(
      {
        ...DEFAULT_CONFIG,
        ankiConnectUrl: mock.url,
        host: '127.0.0.1',
        port: APP_PORT,
      },
      resolve('dist/app'),
    );
    process.stdout.write(`app server on http://127.0.0.1:${server.port}\n`);

    const child = spawn(
      simulatorBinary(),
      [`--automation-port=${SIM_PORT}`, `http://127.0.0.1:${server.port}/?k=${server.accessKey}`],
      { stdio: 'ignore', env: process.env },
    );
    sim = new Simulator(child, SIM_PORT);
    await sim.ready();
    process.stdout.write('simulator up\n');

    // The app announces itself through the SDK bridge before anything is drawn.
    await sim.waitFor(/Bridge initialized/, 0, 30000);
    await sim.waitFor(/"screen":"question"/, 0, 30000);

    let frame = lastFrame(sim.transcript);
    check('first card is the learning card the queue put first', frame?.body === 'Which enzyme unwinds DNA?', JSON.stringify(frame));
    check('header shows deck and progress', /Sub\s+1\//.test(frame?.header ?? ''), frame?.header);
    check('footer tells the wearer what a tap does', /tap answer/.test(frame?.footer ?? ''), frame?.footer);

    const { png: questionShot, bitmap: questionBitmap } = await sim.settled('01-question');
    check('the glasses framebuffer is the expected size', questionBitmap.width === 576 && questionBitmap.height === 288, `${questionBitmap.width}x${questionBitmap.height}`);
    const questionInk = inkRatio(questionBitmap, BODY_REGION);
    check('the question body area actually has text drawn in it', questionInk > 0.001, `ink ${(questionInk * 100).toFixed(3)} percent`);
    checkAgainstBaseline('question-helicase', questionBitmap, questionShot);

    // Reveal the answer.
    let mark = sim.mark();
    await sim.input('click');
    frame = parseFrame(await sim.waitFor(/"screen":"answer"/, mark));
    check('tap reveals the answer', frame?.body === 'Helicase', JSON.stringify(frame));
    check('answer footer lists all four grades', /tap Good.*up Easy.*down Again.*2tap Hard/.test(frame?.footer ?? ''), frame?.footer);

    const { png: answerShot, bitmap: answerBitmap } = await sim.settled('02-answer');
    const bodyChanged = differenceRatio(questionBitmap, answerBitmap, BODY_REGION);
    check('the rendered body changed when the answer was revealed', bodyChanged > 0.001, `${(bodyChanged * 100).toFixed(3)} percent of body pixels changed`);
    const answerInk = inkRatio(answerBitmap, BODY_REGION);
    check('the answer body area has text drawn in it', answerInk > 0.0005, `ink ${(answerInk * 100).toFixed(3)} percent`);
    checkAgainstBaseline('answer-helicase', answerBitmap, answerShot);

    // Swipe up is Easy.
    mark = sim.mark();
    await sim.input('up');
    await sim.waitFor(/"screen":"question"/, mark);
    check('swipe up graded the card Easy in Anki', mock.answers.length === 1 && mock.answers[0]?.ease === 4, JSON.stringify(mock.answers));
    check('the graded card was the one on screen', mock.answers[0]?.cardId === 1005, JSON.stringify(mock.answers));

    // Swipe down is Again.
    mark = sim.mark();
    await sim.input('click');
    await sim.waitFor(/"screen":"answer"/, mark);
    mark = sim.mark();
    await sim.input('down');
    await sim.waitFor(/"screen":"question"/, mark);
    check('swipe down graded the card Again', mock.answers[1]?.ease === 1, JSON.stringify(mock.answers));

    // Double tap is Hard, straight from the answer screen.
    mark = sim.mark();
    await sim.input('click');
    await sim.waitFor(/"screen":"answer"/, mark);
    mark = sim.mark();
    await sim.input('double_click');
    await sim.waitFor(/"screen":"question"|"screen":"done"/, mark);
    check('double tap graded the card Hard', mock.answers[2]?.ease === 2, JSON.stringify(mock.answers));

    const gradedSoFar = mock.answers.length;

    // A double tap on the question screen is inert, and must not grade.
    frame = lastFrame(sim.transcript);
    if (frame?.screen === 'question') {
      await sim.input('double_click');
      await sleep(900);
      await sim.pump();
      check('a double tap on the question screen does not grade anything', mock.answers.length === gradedSoFar, `${gradedSoFar} then ${mock.answers.length}`);
    }

    // A duplicated gesture must not grade twice.
    frame = lastFrame(sim.transcript);
    if (frame?.screen === 'question') {
      mark = sim.mark();
      await sim.input('click');
      await sim.waitFor(/"screen":"answer"/, mark);
      await sim.input('click');
      await sleep(60);
      await sim.input('click');
      await sleep(1500);
      await sim.pump();
      check('a repeated tap did not grade the card twice', mock.answers.length === gradedSoFar + 1, `${gradedSoFar} then ${mock.answers.length}`);
    }

    await sim.pump();
    const bodies = sim.transcript
      .filter((entry) => entry.message.startsWith('frame '))
      .map((entry) => entry.message);

    for (const forbidden of ['Mitochondrion', 'track01', 'See table', 'Speculation on margin', 'Should not appear']) {
      check(`no skipped card reached the glasses: ${forbidden}`, !bodies.some((line) => line.includes(forbidden)));
    }

    const gradedIds = mock.answers.map((entry) => entry.cardId);
    for (const skipped of [1002, 1003, 1004, 1006, 1007, 1010]) {
      check(`skipped card ${skipped} was never graded`, !gradedIds.includes(skipped));
    }

    check('no uncaught errors in the webview', !sim.transcript.some((entry) => /\[uncaught\]|\[unhandledrejection\]/.test(entry.message)),
      sim.transcript.filter((entry) => /\[uncaught\]|\[unhandledrejection\]/.test(entry.message)).map((entry) => entry.message).join(' | '));

    await sim.screenshot('03-final');
  } finally {
    sim?.stop();
    await server?.close();
    await mock?.close();
  }

  process.stdout.write(`\n${checks.length} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`e2e run failed: ${String(error instanceof Error ? error.stack : error)}\n`);
  process.exitCode = 1;
});
