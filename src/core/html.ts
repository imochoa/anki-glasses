/**
 * Turning Anki's rendered card HTML into plain text for a 576x288 display.
 *
 * AnkiConnect returns the fully rendered card, which includes the note type's
 * <style> block and can include <script>. Those must be dropped whole, not
 * tag-stripped, or the card CSS ends up on the glasses as text.
 */

const BLOCK_TAGS = [
  'br', 'div', 'p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '...',
  mdash: '-',
  ndash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  times: 'x',
  deg: ' degrees',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const mapped = ENTITIES[body.toLowerCase()];
    return mapped === undefined ? whole : mapped;
  });
}

/** Remove elements whose contents must never be shown, tags and all. */
export function stripInvisibleElements(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Anki renders the answer as "question, separator, answer" when the template
 * uses FrontSide. Keep only what follows the separator so the glasses do not
 * repeat the prompt.
 */
export function answerBodyOnly(answerHtml: string): string {
  const match = answerHtml.match(/<hr\b[^>]*id=["']?answer["']?[^>]*>/i);
  if (!match || match.index === undefined) return answerHtml;
  return answerHtml.slice(match.index + match[0].length);
}

/**
 * Anki wraps some generated strings, notably the interval labels in
 * nextReviews, in Unicode bidi isolates. The glasses font has no glyph for
 * them, so they would render as placeholder boxes.
 */
export function stripInvisibleCharacters(value: string): string {
  return value.replace(/[⁦-⁩‎‏​­﻿]/g, '');
}

/**
 * Typographic and mathematical characters the glasses font has no glyph for.
 *
 * Observed on a real card on 2026-09-10: an answer beginning with the tilde
 * operator U+223C, meaning approximately, displayed with that character simply
 * gone, turning an approximate range into an exact looking one. A character
 * with no glyph either vanishes or draws as a placeholder box, so anything
 * with a faithful ascii equivalent is spelled out here.
 *
 * Scripts the font does support, notably kana and kanji, are left alone.
 */
const DISPLAY_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[\u223C\u301C\uFF5E\u2248]/g, '~'],
  [/[\u2013\u2014\u2015\u2212\u2011]/g, '-'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '\"'],
  [/[\u2026]/g, '...'],
  [/[\u00B7\u2022]/g, '-'],
  [/[\u00D7]/g, 'x'],
  [/[\u00F7]/g, '/'],
  [/[\u2264]/g, '<='],
  [/[\u2265]/g, '>='],
  [/[\u2260]/g, '!='],
  [/[\u00B1]/g, '+/-'],
  [/[\u00B0]/g, ' deg'],
  [/[\u2192\u21D2]/g, '->'],
  [/[\u2190\u21D0]/g, '<-'],
  [/[\u00A0\u2002\u2003\u2009\u202F\u3000]/g, ' '],
];

/** Replace characters the glasses cannot draw with ascii that means the same. */
export function substituteForDisplay(value: string): string {
  let out = value;
  for (const [pattern, replacement] of DISPLAY_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function htmlToText(html: string): string {
  let text = stripInvisibleElements(html);

  // Anki's audio and video references survive as [sound:file.mp3] in the text.
  text = text.replace(/\[sound:[^\]]*\]/gi, ' ');

  // Raised and lowered type carries meaning that vanishes with the tags:
  // 2<sup>3</sup> would otherwise reach the glasses as 23, a different
  // question. The display has one type size, so it is spelled out instead.
  text = text.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)');
  text = text.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, '_($1)');

  // Cloze deletion placeholders render as [...]; keep them, they carry meaning.
  for (const tag of BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '\n');
    text = text.replace(new RegExp(`</${tag}>`, 'gi'), '\n');
  }

  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = stripInvisibleCharacters(text);
  text = substituteForDisplay(text);

  // Collapse runs of spaces and tabs but keep deliberate line breaks.
  text = text.replace(/[ \t\f\v ]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

export interface MediaFlags {
  hasImage: boolean;
  hasAudioOrVideo: boolean;
  hasMath: boolean;
  hasTable: boolean;
  hasRichMarkup: boolean;
  /** A background image declared in the note type style block. */
  hasNoteTypeBackgroundImage: boolean;
}

/** A css url() reference used as a background, anywhere in a string. */
const CSS_BACKGROUND_IMAGE = /background(-image)?\s*:[^;}"']*url\(/i;

/**
 * Detect content the glasses cannot render.
 *
 * A background image in the card body, for example an inline style attribute,
 * counts as a picture: it can carry the whole question. A background image
 * declared in the note type style block is reported separately, because it
 * decorates every card of that note type rather than belonging to any one
 * card. Measured on this collection on 2026-09-10: no due card carried a css
 * background image in its body, and 31 carried a decorative one in the note
 * type style block.
 */
export function detectMedia(rawHtml: string): MediaFlags {
  const html = stripInvisibleElements(rawHtml);
  const styleBlocks = (rawHtml.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join(' ');
  return {
    hasNoteTypeBackgroundImage: CSS_BACKGROUND_IMAGE.test(styleBlocks),
    hasImage:
      /<img\b/i.test(html) || /<picture\b/i.test(html) || CSS_BACKGROUND_IMAGE.test(html),
    hasAudioOrVideo:
      /\[sound:/i.test(rawHtml) ||
      /<audio\b/i.test(html) ||
      /<video\b/i.test(html) ||
      /\[anki:tts\b/i.test(rawHtml),
    hasMath:
      /\[\/?latex\]/i.test(rawHtml) ||
      /\[\/?\$\$?\]/i.test(rawHtml) ||
      /<anki-mathjax\b/i.test(html) ||
      /\\\(|\\\[/.test(html) ||
      /\$\$[\s\S]+?\$\$/.test(html),
    hasTable: /<table\b/i.test(html),
    hasRichMarkup:
      /<svg\b/i.test(html) ||
      /<canvas\b/i.test(html) ||
      /<iframe\b/i.test(html) ||
      /<object\b/i.test(html) ||
      /<embed\b/i.test(html),
  };
}
