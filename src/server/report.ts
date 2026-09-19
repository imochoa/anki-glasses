/**
 * The skip report: which decks survive a glasses review and which do not.
 *
 * It samples due cards per deck rather than rendering an entire collection,
 * and always says how many it sampled so the numbers are not mistaken for a
 * full count.
 */

import type { DeckReport, SkipReason } from '../shared/types.js';
import { prepareCard, deckAllowed, deckMatches, type FilterConfig } from '../core/suitability.js';
import { AnkiClient, chunk } from './ankiconnect.js';

export interface CollectionReport {
  generatedAt: string;
  sampledCards: number;
  decks: DeckReport[];
  totals: {
    due: number;
    reviewable: number;
    skipped: number;
    skippedByReason: Partial<Record<SkipReason, number>>;
  };
}

/**
 * Decks worth excluding outright: at least ten due cards, under the threshold
 * percent usable, and not above a deck that is worth keeping. An exclusion
 * covers a deck and everything under it, so a parent whose own cards are all
 * pictures must not take a readable subdeck down with it. A subdeck with
 * nothing due today still counts as worth keeping: the report is a snapshot
 * of one day's due list, and the exclusion it writes lasts.
 */
export function decksToExclude(decks: DeckReport[], threshold: number): string[] {
  const unusable = decks
    .filter((deck) => !deck.excluded && deck.due >= 10)
    .filter((deck) => (deck.reviewable / deck.due) * 100 < threshold)
    .map((deck) => deck.deck);
  const unusableSet = new Set(unusable);
  const kept = decks.filter((deck) => !deck.excluded && !unusableSet.has(deck.deck));
  return unusable.filter(
    (deck) => !kept.some((other) => other.deck !== deck && deckMatches(deck, other.deck)),
  );
}

function quote(deck: string): string {
  return deck.replace(/["\\]/g, '\\$&');
}

export async function buildReport(
  anki: AnkiClient,
  filter: FilterConfig,
  sampleLimit = 400,
): Promise<CollectionReport> {
  const decks = await anki.deckNames();
  const perDeckCap = Math.max(5, Math.ceil(sampleLimit / Math.max(1, decks.length)));

  const reports: DeckReport[] = [];
  const totals: CollectionReport['totals'] = {
    due: 0,
    reviewable: 0,
    skipped: 0,
    skippedByReason: {},
  };
  let sampledCards = 0;

  for (const deck of decks) {
    // Cards sitting directly in this deck, not in its subdecks, so a parent
    // deck does not double count everything below it.
    const query = `"deck:${quote(deck)}" -"deck:${quote(deck)}::*" is:due -is:suspended -is:buried`;
    const due = await anki.findCards(query);
    const excluded = !deckAllowed(deck, filter);

    const entry: DeckReport = {
      deck,
      due: due.length,
      reviewable: 0,
      skipped: 0,
      skippedByReason: {},
      excluded,
    };
    totals.due += due.length;

    if (due.length === 0) {
      reports.push(entry);
      continue;
    }

    if (excluded) {
      entry.skipped = due.length;
      entry.skippedByReason['deck-excluded'] = due.length;
      totals.skipped += due.length;
      totals.skippedByReason['deck-excluded'] =
        (totals.skippedByReason['deck-excluded'] ?? 0) + due.length;
      reports.push(entry);
      continue;
    }

    const sample = due.slice(0, perDeckCap);
    let tags = new Map<number, string[]>();

    for (const group of chunk(sample, 40)) {
      const info = await anki.cardsInfo(group);
      if (filter.excludeTags.length > 0) {
        tags = await anki.notesTags([...new Set(info.map((card) => card.note))]);
      }
      for (const card of info) {
        sampledCards += 1;
        const prepared = prepareCard(
          {
            deck: card.deckName,
            questionHtml: card.question,
            answerHtml: card.answer,
            tags: tags.get(card.note) ?? [],
            noteType: card.modelName,
          },
          filter,
        );
        if (prepared.ok) {
          entry.reviewable += 1;
        } else {
          entry.skipped += 1;
          for (const reason of prepared.reasons) {
            entry.skippedByReason[reason] = (entry.skippedByReason[reason] ?? 0) + 1;
            totals.skippedByReason[reason] = (totals.skippedByReason[reason] ?? 0) + 1;
          }
        }
      }
    }

    // Scale the sample back up so the deck line is comparable with due.
    if (sample.length > 0 && sample.length < due.length) {
      const factor = due.length / sample.length;
      entry.reviewable = Math.round(entry.reviewable * factor);
      entry.skipped = due.length - entry.reviewable;
    }

    totals.reviewable += entry.reviewable;
    totals.skipped += entry.skipped;
    reports.push(entry);
  }

  return {
    generatedAt: new Date().toISOString(),
    sampledCards,
    // Every deck, including those with nothing due today, so a decision made
    // from this report knows which subdecks exist.
    decks: reports.sort((a, b) => b.due - a.due),
    totals,
  };
}
