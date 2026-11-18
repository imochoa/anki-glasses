/**
 * Gesture handling, as a pure reducer so it can be tested without hardware.
 *
 * Only five discrete gestures exist on the R1 ring and the temple pad, so the
 * mapping has to cover reveal, four grades and quit without overloading any one
 * of them ambiguously.
 */

import {
  EASE_AGAIN,
  EASE_EASY,
  EASE_GOOD,
  EASE_HARD,
  type Ease,
  type Gesture,
  type GestureSource,
} from '../shared/types.js';

/** Values of OsEventTypeList in the Even Hub SDK. */
export const OS_EVENT = {
  click: 0,
  scrollTop: 1,
  scrollBottom: 2,
  doubleClick: 3,
  foregroundEnter: 4,
  foregroundExit: 5,
  abnormalExit: 6,
  systemExit: 7,
  imuReport: 8,
  longPress: 9,
  longPressRelease: 10,
} as const;

/** Values of EventSourceType in the Even Hub SDK. */
export const EVENT_SOURCE = {
  dummy: 0,
  glassesRight: 1,
  ring: 2,
  glassesLeft: 3,
} as const;

export function gestureFromOsEvent(eventType: number | undefined): Gesture | null {
  switch (eventType) {
    case OS_EVENT.click:
      return 'click';
    case OS_EVENT.doubleClick:
      return 'double_click';
    case OS_EVENT.scrollTop:
      return 'up';
    case OS_EVENT.scrollBottom:
      return 'down';
    case OS_EVENT.longPress:
      return 'long_press';
    default:
      return null;
  }
}

/** The shape the host actually pushes, loosely typed on purpose. */
export interface RawEvenHubEvent {
  sysEvent?: { eventType?: unknown; eventSource?: unknown } | null;
  textEvent?: { eventType?: unknown } | null;
  listEvent?: { eventType?: unknown } | null;
}

/**
 * Read a gesture out of a host event.
 *
 * The wire format is protobuf derived and leaves out any field holding its
 * default value. CLICK_EVENT is ordinal zero, so a real tap arrives as
 * `{"sysEvent":{"eventSource":1}}` with no eventType at all. Verified against
 * the official simulator on 2026-09-10. Treating a touch event with no
 * eventType as anything other than a tap loses every single tap.
 */
export function gestureFromEvenHubEvent(event: RawEvenHubEvent): {
  gesture: Gesture | null;
  source: GestureSource;
} {
  const payload = event.sysEvent ?? event.textEvent ?? event.listEvent ?? null;
  const source = sourceFromEventSource(
    typeof event.sysEvent?.eventSource === 'number' ? event.sysEvent.eventSource : undefined,
  );
  if (!payload) return { gesture: null, source };

  const raw = payload.eventType;
  const eventType = typeof raw === 'number' ? raw : OS_EVENT.click;
  return { gesture: gestureFromOsEvent(eventType), source };
}

export function sourceFromEventSource(value: number | undefined): GestureSource {
  switch (value) {
    case EVENT_SOURCE.ring:
      return 'ring';
    case EVENT_SOURCE.glassesLeft:
      return 'glasses_left';
    case EVENT_SOURCE.glassesRight:
      return 'glasses_right';
    default:
      return 'unknown';
  }
}

export type Screen = 'loading' | 'decks' | 'question' | 'answer' | 'done' | 'error';

export interface UiState {
  screen: Screen;
  /**
   * Page currently shown on the active side. On the deck list it is the
   * highlighted entry instead.
   */
  page: number;
  /** Pages available on the active side, or entries on the deck list. */
  pageCount: number;
}

export type Action =
  | { kind: 'none' }
  | { kind: 'page'; page: number }
  | { kind: 'reveal' }
  | { kind: 'grade'; ease: Ease }
  | { kind: 'quit' }
  | { kind: 'refresh' }
  /** Move the highlight on the deck list. */
  | { kind: 'select'; index: number }
  /** Start a session on the highlighted deck. */
  | { kind: 'pick'; index: number }
  /** Go back to the deck list. */
  | { kind: 'decks' };

export interface GradeMapping {
  click: Ease;
  up: Ease;
  down: Ease;
  double_click: Ease;
}

export const DEFAULT_GRADES: GradeMapping = {
  click: EASE_GOOD,
  up: EASE_EASY,
  down: EASE_AGAIN,
  double_click: EASE_HARD,
};

/**
 * The footer legend, built from the mapping actually in force. A hard coded
 * legend would tell the wearer to tap for Good while recording something else
 * as soon as the mapping is changed.
 */
export function gradeLegend(grades: GradeMapping, labels: Record<Ease, string>): string {
  return [
    `tap ${labels[grades.click]}`,
    `up ${labels[grades.up]}`,
    `down ${labels[grades.down]}`,
    `2tap ${labels[grades.double_click]}`,
  ].join('   ');
}

/**
 * Decide what a gesture means in the current state.
 *
 * Paging always wins over grading while pages remain, so the gesture that
 * carries the reader onto the last page cannot also grade the card.
 */
export function reduce(
  state: UiState,
  gesture: Gesture,
  grades: GradeMapping = DEFAULT_GRADES,
): Action {
  if (gesture === 'long_press') return { kind: 'quit' };

  const lastPage = Math.max(0, state.pageCount - 1);
  const canPageForward = state.page < lastPage;
  const canPageBack = state.page > 0;

  switch (state.screen) {
    case 'loading':
      return { kind: 'none' };

    case 'decks': {
      // The list does not wrap, so a swipe past either end is harmless and the
      // wearer can always find the top by swiping up until nothing moves.
      if (gesture === 'up') {
        return canPageBack ? { kind: 'select', index: state.page - 1 } : { kind: 'none' };
      }
      if (gesture === 'down') {
        return canPageForward ? { kind: 'select', index: state.page + 1 } : { kind: 'none' };
      }
      if (gesture === 'click') return { kind: 'pick', index: state.page };
      return { kind: 'none' };
    }

    case 'question': {
      // Double tap is deliberately inert here. Undo is not offered, because
      // AnkiConnect's undo reverses the last operation in the whole
      // collection, which can be something done on the desktop instead.
      if (gesture === 'double_click') return { kind: 'none' };
      if (gesture === 'up') {
        return canPageBack ? { kind: 'page', page: state.page - 1 } : { kind: 'none' };
      }
      if (gesture === 'click' || gesture === 'down') {
        return canPageForward ? { kind: 'page', page: state.page + 1 } : { kind: 'reveal' };
      }
      return { kind: 'none' };
    }

    case 'answer': {
      // Grading is armed only on the last page, so the gesture that carries the
      // reader onto that page cannot also grade the card. While pages remain,
      // up and down page through the answer instead, and a double tap is inert,
      // because two quick taps meant to turn pages can arrive as one double tap
      // and would otherwise grade an answer the reader has not finished.
      if (canPageForward) {
        if (gesture === 'click' || gesture === 'down') {
          return { kind: 'page', page: state.page + 1 };
        }
        if (gesture === 'up') {
          return canPageBack ? { kind: 'page', page: state.page - 1 } : { kind: 'none' };
        }
        return { kind: 'none' };
      }
      if (gesture === 'click') return { kind: 'grade', ease: grades.click };
      if (gesture === 'up') return { kind: 'grade', ease: grades.up };
      if (gesture === 'down') return { kind: 'grade', ease: grades.down };
      if (gesture === 'double_click') return { kind: 'grade', ease: grades.double_click };
      return { kind: 'none' };
    }

    case 'done':
      if (gesture === 'click') return { kind: 'refresh' };
      // Nothing is on screen to grade, so a double tap cannot cost a review.
      if (gesture === 'double_click') return { kind: 'decks' };
      return { kind: 'none' };

    case 'error':
      if (gesture === 'click' || gesture === 'double_click') return { kind: 'refresh' };
      return { kind: 'none' };

    default:
      return { kind: 'none' };
  }
}
