/**
 * The glasses app. Pulls cards from the local server, draws them, and turns
 * ring gestures into Anki grades.
 */

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GRADES,
  gestureFromEvenHubEvent,
  gradeLegend,
  reduce,
  type GradeMapping,
  type RawEvenHubEvent,
  type UiState,
} from '../core/interaction.js';
import {
  EASE_LABELS,
  type AnswerResponse,
  type Ease,
  type Gesture,
  type NextCardResponse,
  type ReviewCard,
} from '../shared/types.js';
import { explainFailure } from '../core/errors.js';
import { GlassesDisplay, type Frame } from './glasses.js';

const API = {
  config: '/api/config',
  start: '/api/session/start',
  next: '/api/session/next',
  answer: '/api/session/answer',
};

/**
 * The pairing key arrives in the address the phone opens, which is what the
 * QR code encodes. It is kept out of the served bundle on purpose.
 */
const ACCESS_KEY = new URLSearchParams(location.search).get('k') ?? '';

/** Two identical gestures closer together than this are treated as one. */
const DUPLICATE_WINDOW_MS = 120;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-anki-glasses-key': ACCESS_KEY,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let code = `http-${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { code?: string };
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      // not json, keep the status based code
    }
    const failure = new Error(`${path} returned ${response.status} ${detail.slice(0, 160)}`);
    (failure as Error & { code?: string }).code = code;
    throw failure;
  }
  return (await response.json()) as T;
}


function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}...`;
}

/** The deck name is shown leaf first, because that is the informative part. */
function shortDeck(deck: string): string {
  const parts = deck.split('::');
  return truncate(parts[parts.length - 1] ?? deck, 28);
}

class AnkiGlassesApp {
  private display!: GlassesDisplay;
  private grades: GradeMapping = DEFAULT_GRADES;

  private card: ReviewCard | null = null;
  private state: UiState = { screen: 'loading', page: 0, pageCount: 1 };
  private answeredThisSession = 0;
  private notice = '';
  private busy = false;
  private lastGesture: { gesture: Gesture; at: number } | null = null;

  async run(): Promise<void> {
    const bridge = await waitForEvenAppBridge();
    this.display = new GlassesDisplay(bridge);
    await this.display.create(this.frame());

    bridge.onEvenHubEvent((event) => {
      const { gesture, source } = gestureFromEvenHubEvent(event as RawEvenHubEvent);
      if (!gesture) return;
      // Source is logged but never filtered on: the simulator always reports
      // the right temple, and the temple pad is a legitimate fallback input.
      console.log(`gesture ${gesture} from ${source}`);
      void this.onGesture(gesture);
    });

    try {
      this.grades = (await api<{ grades: GradeMapping }>(API.config)).grades ?? DEFAULT_GRADES;
    } catch (error) {
      console.log(`config fetch failed, using defaults: ${String(error)}`);
    }

    await this.startSession();
  }

  private async startSession(): Promise<void> {
    this.busy = true;
    try {
      await api(API.start, { method: 'POST', body: '{}' });
      this.answeredThisSession = 0;
      this.notice = '';
      await this.loadNext();
    } catch (error) {
      await this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private async loadNext(): Promise<void> {
    const next = await api<NextCardResponse>(API.next);
    this.applyNext(next);
    await this.draw();
  }

  private applyNext(next: NextCardResponse): void {
    if (next.done || !next.card) {
      this.card = null;
      this.state = { screen: 'done', page: 0, pageCount: 1 };
      return;
    }
    this.card = next.card;
    this.state = {
      screen: 'question',
      page: 0,
      pageCount: next.card.questionPages.length,
    };
  }

  private async onGesture(gesture: Gesture): Promise<void> {
    const now = Date.now();
    if (
      this.lastGesture &&
      this.lastGesture.gesture === gesture &&
      now - this.lastGesture.at < DUPLICATE_WINDOW_MS
    ) {
      console.log(`ignored duplicate ${gesture}`);
      return;
    }
    this.lastGesture = { gesture, at: now };

    if (this.busy) {
      console.log(`busy, dropped ${gesture}`);
      return;
    }

    const action = reduce(this.state, gesture, this.grades);
    if (action.kind === 'none') return;

    this.busy = true;
    try {
      switch (action.kind) {
        case 'page':
          this.state = { ...this.state, page: action.page };
          break;

        case 'reveal':
          if (this.card) {
            this.state = {
              screen: 'answer',
              page: 0,
              pageCount: this.card.answerPages.length,
            };
          }
          break;

        case 'grade':
          await this.grade(action.ease);
          break;

        case 'refresh':
          await this.startSession();
          return;

        case 'quit':
          await this.display.close();
          return;
      }
      await this.draw();
    } catch (error) {
      await this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private async grade(ease: Ease): Promise<void> {
    if (!this.card) return;
    const result = await api<AnswerResponse>(API.answer, {
      method: 'POST',
      body: JSON.stringify({ token: this.card.token, ease }),
    });

    switch (result.outcome) {
      case 'graded':
        this.answeredThisSession += 1;
        this.notice = result.interval
          ? `${EASE_LABELS[ease]} ${result.interval}`
          : EASE_LABELS[ease];
        break;
      case 'duplicate':
        // The same gesture arrived twice. The first one was recorded.
        console.log('server rejected a repeated answer token');
        break;
      case 'unknown-token':
        // The grade went nowhere, so do not let the wearer believe it landed.
        this.notice = 'Session restarted, not graded';
        break;
      case 'not-due':
        this.notice = 'Already answered elsewhere';
        break;
    }
    this.applyNext(result.next);
  }

  private async showError(error: unknown): Promise<void> {
    console.log(`error: ${String(error)}`);
    this.state = { screen: 'error', page: 0, pageCount: 1 };
    this.notice = explainFailure(error);
    await this.draw();
  }

  private pageMarker(): string {
    return this.state.pageCount > 1 ? `  ${this.state.page + 1}/${this.state.pageCount}` : '';
  }

  private frame(): Frame {
    switch (this.state.screen) {
      case 'loading':
        return { header: 'Anki', body: 'Loading cards...', footer: '' };

      case 'question': {
        const card = this.card;
        if (!card) return { header: 'Anki', body: 'No card', footer: '' };
        return {
          header: `${shortDeck(card.deck)}   ${this.answeredThisSession + 1}/${card.total}${this.pageMarker()}`,
          body: card.questionPages[this.state.page] ?? '',
          footer: 'tap answer    hold quit',
        };
      }

      case 'answer': {
        const card = this.card;
        if (!card) return { header: 'Anki', body: 'No card', footer: '' };
        return {
          header: `${shortDeck(card.deck)}   ${this.answeredThisSession + 1}/${card.total}${this.pageMarker()}`,
          body: card.answerPages[this.state.page] ?? '',
          footer:
            this.state.page < this.state.pageCount - 1
              ? 'tap more    hold quit'
              : gradeLegend(this.grades, EASE_LABELS),
        };
      }

      case 'done':
        return {
          header: 'Anki',
          body:
            this.answeredThisSession > 0
              ? `Done. ${this.answeredThisSession} reviewed.`
              : 'Nothing due that fits the glasses.',
          footer: 'tap check again    hold quit',
        };

      case 'error':
        return { header: 'Anki', body: this.notice || 'Something went wrong', footer: 'tap retry' };

      default:
        return { header: 'Anki', body: '', footer: '' };
    }
  }

  private async draw(): Promise<void> {
    const frame = this.frame();
    if (this.notice && (this.state.screen === 'question' || this.state.screen === 'done')) {
      frame.header = `${frame.header}   ${this.notice}`;
      this.notice = '';
    }
    await this.display.render(frame);
    // Logged after the display accepted the frame, so the line records what
    // was sent rather than what was intended. Screenshot assertions in the end
    // to end run check the pixels independently.
    console.log(`frame ${JSON.stringify({ screen: this.state.screen, ...frame })}`);
  }
}

const app = new AnkiGlassesApp();
app.run().catch((error) => {
  console.log(`fatal: ${String(error)}`);
});
