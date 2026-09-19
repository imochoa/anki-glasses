/**
 * Deciding which cards belong on the glasses.
 *
 * A card that fails here is never answered and never buried. It is simply not
 * served, so it stays due and waits for a normal desktop review.
 */

import type { SkipReason, Suitability } from '../shared/types.js';
import { answerBodyOnly, detectMedia, htmlToText } from './html.js';
import { DEFAULT_LAYOUT, layoutPages, type LayoutConfig } from './layout.js';

export interface FilterConfig {
  /** When non-empty, only these decks and their subdecks are reviewed. */
  includeDecks: string[];
  /** These decks and their subdecks are never reviewed. */
  excludeDecks: string[];
  /** A note carrying any of these tags is never reviewed. */
  excludeTags: string[];
  /** Notes of these types are never reviewed. */
  excludeNoteTypes: string[];
  skipImages: boolean;
  skipAudioVideo: boolean;
  skipMath: boolean;
  skipTables: boolean;
  skipRichMarkup: boolean;
  /**
   * Also skip cards whose note type style block declares a background image.
   * Off by default because that styling decorates every card of the note type
   * rather than belonging to one card, and turning it on hides 31 otherwise
   * readable cards in this collection.
   */
  skipNoteTypeBackgrounds: boolean;
  /**
   * Optional hard character cap per side, on top of the page budget.
   * Null means the page budget alone decides.
   */
  maxChars: number | null;
  layout: LayoutConfig;
}

export const DEFAULT_FILTER: FilterConfig = {
  includeDecks: [],
  excludeDecks: [],
  excludeTags: ['noglasses'],
  excludeNoteTypes: [],
  skipImages: true,
  skipAudioVideo: true,
  skipMath: true,
  skipTables: true,
  skipRichMarkup: true,
  skipNoteTypeBackgrounds: false,
  maxChars: null,
  layout: DEFAULT_LAYOUT,
};

/**
 * Deck patterns match a deck and everything under it. Anki separates levels
 * with "::", so "Japanese" excludes "Japanese::Verbs" but not "Japanese Extra".
 */
export function deckMatches(pattern: string, deck: string): boolean {
  const p = pattern.trim().toLowerCase();
  const d = deck.trim().toLowerCase();
  if (p === '') return false;
  return d === p || d.startsWith(`${p}::`);
}

export function deckAllowed(deck: string, config: FilterConfig): boolean {
  if (config.excludeDecks.some((pattern) => deckMatches(pattern, deck))) return false;
  if (config.includeDecks.length === 0) return true;
  return config.includeDecks.some((pattern) => deckMatches(pattern, deck));
}

export interface CardContent {
  deck: string;
  questionHtml: string;
  answerHtml: string;
  tags: string[];
  noteType: string;
}

export interface PreparedCard extends Suitability {
  questionPages: string[];
  answerPages: string[];
  questionText: string;
  answerText: string;
}

/**
 * Render a card to plain text, paginate it, and decide whether it can be shown.
 * Returns the prepared text either way so the skip report can quote it.
 */
export function prepareCard(card: CardContent, config: FilterConfig): PreparedCard {
  const reasons: SkipReason[] = [];

  if (!deckAllowed(card.deck, config)) reasons.push('deck-excluded');

  const lowerTags = card.tags.map((tag) => tag.toLowerCase());
  if (config.excludeTags.some((tag) => lowerTags.includes(tag.toLowerCase()))) {
    reasons.push('tag-excluded');
  }

  if (
    config.excludeNoteTypes.some(
      (name) => name.trim().toLowerCase() === card.noteType.trim().toLowerCase(),
    )
  ) {
    reasons.push('note-type-excluded');
  }

  const answerHtml = answerBodyOnly(card.answerHtml);
  const media = {
    question: detectMedia(card.questionHtml),
    answer: detectMedia(answerHtml),
  };
  const either = (key: keyof typeof media.question) =>
    media.question[key] || media.answer[key];

  const carriesPicture =
    either('hasImage') ||
    (config.skipNoteTypeBackgrounds && either('hasNoteTypeBackgroundImage'));
  if (config.skipImages && carriesPicture) reasons.push('image');
  if (config.skipAudioVideo && either('hasAudioOrVideo')) reasons.push('media');
  if (config.skipMath && either('hasMath')) reasons.push('math');
  if (config.skipTables && either('hasTable')) reasons.push('table');
  if (config.skipRichMarkup && either('hasRichMarkup')) reasons.push('markup');

  const questionText = htmlToText(card.questionHtml);
  const answerText = htmlToText(answerHtml);

  if (questionText === '' || answerText === '') reasons.push('empty');

  const longestSide = Math.max(questionText.length, answerText.length);
  if (config.maxChars !== null && longestSide > config.maxChars) {
    reasons.push('too-long');
  }

  const questionPages = layoutPages(questionText, config.layout);
  const answerPages = layoutPages(answerText, config.layout);
  const budget = Math.max(1, config.layout.maxPages);
  if (
    !reasons.includes('too-long') &&
    (questionPages.length > budget || answerPages.length > budget)
  ) {
    reasons.push('too-long');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    longestSide,
    questionPages,
    answerPages,
    questionText,
    answerText,
  };
}
