/**
 * Print which decks survive a glasses review and why the rest do not.
 *
 * Read only. It renders cards and counts them, and never writes to Anki.
 *
 *   ANKI_CONNECT_URL=http://127.0.0.1:8765 npm run report -- --limit 2000
 *
 * With --write-config it also writes deck level exclusions for decks whose
 * cards mostly cannot be shown, so those decks are skipped outright rather
 * than being filtered card by card every session:
 *
 *   npm run report -- --limit 400000 --write-config --threshold 20
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { AnkiClient } from '../src/server/ankiconnect.js';
import { loadConfig } from '../src/server/config.js';
import { buildReport, decksToExclude } from '../src/server/report.js';
import type { SkipReason } from '../src/shared/types.js';

const REASON_LABEL: Record<SkipReason, string> = {
  image: 'image',
  media: 'audio or video',
  math: 'math',
  table: 'table',
  markup: 'rich markup',
  'too-long': 'too long',
  empty: 'nothing to show',
  'deck-excluded': 'deck excluded',
  'tag-excluded': 'tag excluded',
  'note-type-excluded': 'note type excluded',
};

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function reasonSummary(byReason: Partial<Record<SkipReason, number>>): string {
  const parts = Object.entries(byReason)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([reason, count]) => `${REASON_LABEL[reason as SkipReason]} ${count}`);
  return parts.join(', ');
}

/**
 * Write deck exclusions for decks that are mostly unusable on the glasses.
 * Only excludeDecks is touched, so anything else already in the file survives.
 */
function writeDeckExclusions(path: string, decks: string[]): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const filter = (existing.filter ?? {}) as Record<string, unknown>;
  const previous = Array.isArray(filter.excludeDecks) ? (filter.excludeDecks as string[]) : [];
  filter.excludeDecks = [...new Set([...previous, ...decks])].sort();
  existing.filter = filter;
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? '400', 10) : 400;
  const thresholdIndex = args.indexOf('--threshold');
  const threshold = thresholdIndex >= 0 ? Number.parseInt(args[thresholdIndex + 1] ?? '20', 10) : 20;
  const writeConfig = args.includes('--write-config');
  const configPathIndex = args.indexOf('--config-path');
  const configPath =
    configPathIndex >= 0 ? (args[configPathIndex + 1] ?? '') : 'anki-glasses.config.json';

  const config = loadConfig();
  const anki = new AnkiClient({ url: config.ankiConnectUrl, apiKey: config.ankiConnectKey });

  process.stdout.write(`Reading ${config.ankiConnectUrl}\n`);
  const report = await buildReport(anki, config.filter, limit);

  process.stdout.write(
    `\nSampled ${report.sampledCards} of ${report.totals.due} due cards at ${report.generatedAt}\n\n`,
  );
  process.stdout.write(`${pad('deck', 46)}${pad('due', 7)}${pad('glasses', 9)}why the rest are held back\n`);
  process.stdout.write(`${'-'.repeat(110)}\n`);

  for (const deck of report.decks) {
    if (deck.due === 0) continue;
    process.stdout.write(
      `${pad(deck.deck, 46)}${pad(String(deck.due), 7)}${pad(String(deck.reviewable), 9)}${reasonSummary(
        deck.skippedByReason,
      )}\n`,
    );
  }

  const share =
    report.totals.due > 0 ? Math.round((report.totals.reviewable / report.totals.due) * 100) : 0;
  process.stdout.write(
    `\nTotal due ${report.totals.due}, reviewable on the glasses about ${report.totals.reviewable} (${share} percent)\n`,
  );
  process.stdout.write(`Held back: ${reasonSummary(report.totals.skippedByReason)}\n`);

  // Decks where almost nothing can be shown are better excluded outright, so
  // the session does not walk the whole deck every time to find nothing.
  const mostlyUnusable = decksToExclude(report.decks, threshold);

  if (mostlyUnusable.length === 0) {
    process.stdout.write(`\nNo deck falls below ${threshold} percent usable.\n`);
    return;
  }

  process.stdout.write(`\nDecks under ${threshold} percent usable on the glasses:\n`);
  for (const deck of mostlyUnusable) process.stdout.write(`  ${deck}\n`);

  if (writeConfig) {
    writeDeckExclusions(configPath, mostlyUnusable);
    process.stdout.write(`\nAdded them to filter.excludeDecks in ${configPath}\n`);
  } else {
    process.stdout.write(`\nRerun with --write-config to add these to excludeDecks.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`report failed: ${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
