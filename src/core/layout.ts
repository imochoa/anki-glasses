/**
 * Fitting card text to the G2 display.
 *
 * The glasses are 576x288 with no scrollbar: text that overflows its container
 * is simply not shown. So the server wraps and paginates before sending, and
 * the suitability filter rejects anything that needs more pages than allowed.
 */

/** Firmware rejects a text container payload at or above 1000 bytes. */
export const MAX_TEXT_BYTES = 999;

export interface LayoutConfig {
  /** Characters that fit on one line of the body container. */
  charsPerLine: number;
  /** Body lines visible at once. */
  linesPerScreen: number;
  /** Pages a single side of a card may use before it is skipped. */
  maxPages: number;
}

/**
 * Measured on the official simulator at 576x288 on 2026-09-10, using a digit
 * ruler: a full width line held 49 to 50 digits and the screen held about 10
 * rows at roughly 28px each. The G2 font is proportional, not monospace, so
 * these defaults sit deliberately under the measurement. The body container is
 * 206px tall, which is 7 rows, and 6 is used to leave room for a wide glyph
 * run pushing an extra wrap.
 */
export const DEFAULT_LAYOUT: LayoutConfig = {
  charsPerLine: 42,
  linesPerScreen: 6,
  maxPages: 1,
};

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Break a word that cannot fit on one line into line-sized pieces. */
function splitLongWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (rest.length > width) {
    pieces.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/** Greedy word wrap that preserves deliberate line breaks. */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) throw new Error('charsPerLine must be at least 1');
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const trimmed = paragraph.trim();
    if (trimmed === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of trimmed.split(/\s+/)) {
      const pieces = word.length > width ? splitLongWord(word, width) : [word];
      for (const piece of pieces) {
        if (current === '') {
          current = piece;
        } else if (current.length + 1 + piece.length <= width) {
          current = `${current} ${piece}`;
        } else {
          lines.push(current);
          current = piece;
        }
      }
    }
    if (current !== '') lines.push(current);
  }

  // A leading or trailing blank line wastes a scarce row.
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines;
}

/**
 * Group wrapped lines into pages. A page is additionally cut short if it would
 * exceed the firmware byte cap, which matters for scripts where one character
 * costs three bytes.
 */
export function paginate(lines: string[], linesPerScreen: number): string[] {
  if (linesPerScreen < 1) throw new Error('linesPerScreen must be at least 1');
  const pages: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      pages.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const candidate = [...current, line];
    const tooManyLines = candidate.length > linesPerScreen;
    const tooManyBytes = utf8Bytes(candidate.join('\n')) > MAX_TEXT_BYTES;
    if (current.length > 0 && (tooManyLines || tooManyBytes)) {
      flush();
    }
    current.push(line);
    // A single line over the byte cap cannot be helped by starting a new page.
    if (utf8Bytes(current.join('\n')) > MAX_TEXT_BYTES && current.length === 1) {
      current = [truncateToBytes(line, MAX_TEXT_BYTES)];
      flush();
    }
  }
  flush();

  return pages.length > 0 ? pages : [''];
}

/** Cut a string so its utf8 encoding fits, without splitting a code point. */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = '';
  for (const char of value) {
    if (utf8Bytes(result + char) > maxBytes) break;
    result += char;
  }
  return result;
}

export function layoutPages(text: string, config: LayoutConfig): string[] {
  return paginate(wrapText(text, config.charsPerLine), config.linesPerScreen);
}
