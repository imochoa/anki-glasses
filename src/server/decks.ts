/**
 * The deck list the glasses offer before a session, and how a picked deck
 * narrows the session's filter.
 */

import type { DeckSummary } from '../shared/types.js';
import { deckAllowed, type FilterConfig } from '../core/suitability.js';
import type { AnkiClient } from './ankiconnect.js';
import { rootDecks } from './session.js';

/**
 * The top level trees the filter allows, alphabetically, with what Anki will
 * serve from each today. Subdecks are not listed separately: a tree is what a
 * session walks, and the glasses have room for a short list only.
 */
export async function listDecks(anki: AnkiClient, filter: FilterConfig): Promise<DeckSummary[]> {
  const allowed = (await anki.deckNames()).filter((deck) => deckAllowed(deck, filter));
  const roots = rootDecks(allowed).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  if (roots.length === 0) return [];

  // Real AnkiConnect keys the answer by deck id, so match on the name inside.
  const stats = await anki.getDeckStats(roots);
  const dueByName = new Map<string, number>();
  for (const entry of Object.values(stats)) {
    dueByName.set(entry.name, entry.learn_count + entry.review_count);
  }
  return roots.map((name) => ({ name, due: dueByName.get(name) ?? 0 }));
}

/**
 * The filter for a session limited to one deck tree. Every other rule of the
 * configured filter still applies, so picking a deck can never reach one the
 * configuration excludes. Returns null when the deck is not one the filter
 * allows, so the caller can refuse it.
 */
export function filterForDeck(filter: FilterConfig, deck: string): FilterConfig | null {
  if (!deckAllowed(deck, filter)) return null;
  return { ...filter, includeDecks: [deck] };
}
