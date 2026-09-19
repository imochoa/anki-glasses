/**
 * Minimal AnkiConnect client.
 *
 * Everything that changes scheduling goes through answerCards, so Anki's own
 * scheduler picks the next interval. This app never writes intervals itself.
 */

export interface AnkiCardInfo {
  cardId: number;
  note: number;
  deckName: string;
  modelName: string;
  question: string;
  answer: string;
  due: number;
  type: number;
  queue: number;
  interval: number;
  reps: number;
  lapses: number;
  nextReviews?: string[];
}

export interface DeckStats {
  deck_id: number;
  name: string;
  new_count: number;
  learn_count: number;
  review_count: number;
  total_in_deck: number;
}

export class AnkiError extends Error {}

export interface AnkiClientOptions {
  url?: string;
  timeoutMs?: number;
  apiKey?: string | null;
}

export class AnkiClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | null;

  constructor(options: AnkiClientOptions = {}) {
    this.url = options.url ?? process.env.ANKI_CONNECT_URL ?? 'http://127.0.0.1:8765';
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.apiKey = options.apiKey ?? process.env.ANKI_CONNECT_KEY ?? null;
  }

  async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const body: Record<string, unknown> = { action, version: 6, params };
    if (this.apiKey) body.key = this.apiKey;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new AnkiError(
        `Cannot reach AnkiConnect at ${this.url}. Is Anki running with the AnkiConnect add-on? (${String(cause)})`,
      );
    }

    if (!response.ok) {
      throw new AnkiError(`AnkiConnect returned HTTP ${response.status} for ${action}`);
    }

    const payload = (await response.json()) as { result: T; error: string | null };
    if (payload.error) throw new AnkiError(`AnkiConnect ${action} failed: ${payload.error}`);
    return payload.result;
  }

  version(): Promise<number> {
    return this.invoke<number>('version');
  }

  deckNames(): Promise<string[]> {
    return this.invoke<string[]>('deckNames');
  }

  findCards(query: string): Promise<number[]> {
    return this.invoke<number[]>('findCards', { query });
  }

  cardsInfo(cards: number[]): Promise<AnkiCardInfo[]> {
    if (cards.length === 0) return Promise.resolve([]);
    return this.invoke<AnkiCardInfo[]>('cardsInfo', { cards });
  }

  getDeckStats(decks: string[]): Promise<Record<string, DeckStats>> {
    if (decks.length === 0) return Promise.resolve({});
    return this.invoke<Record<string, DeckStats>>('getDeckStats', { decks });
  }

  /** Tags live on the note, not the card, so this is only called when needed. */
  async notesTags(notes: number[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    if (notes.length === 0) return result;
    const info = await this.invoke<Array<{ noteId: number; tags: string[] }>>('notesInfo', {
      notes,
    });
    for (const note of info) result.set(note.noteId, note.tags ?? []);
    return result;
  }

  /** Grade one card through Anki's scheduler. Returns true when applied. */
  async answerCard(cardId: number, ease: number): Promise<boolean> {
    const results = await this.invoke<boolean[]>('answerCards', {
      answers: [{ cardId, ease }],
    });
    return results[0] === true;
  }
}

/** Split a list into fixed size chunks, for batched cardsInfo calls. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
