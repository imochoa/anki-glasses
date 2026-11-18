import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  answerBodyOnly,
  decodeEntities,
  detectMedia,
  htmlToText,
  stripInvisibleCharacters,
} from '../src/core/html.js';
import {
  DEFAULT_LAYOUT,
  MAX_TEXT_BYTES,
  layoutPages,
  paginate,
  truncateToBytes,
  utf8Bytes,
  wrapText,
} from '../src/core/layout.js';
import { DEFAULT_FILTER, deckMatches, deckAllowed, prepareCard } from '../src/core/suitability.js';
import {
  DEFAULT_GRADES,
  gestureFromEvenHubEvent,
  gestureFromOsEvent,
  gradeLegend,
  reduce,
  sourceFromEventSource,
} from '../src/core/interaction.js';
import { EASE_LABELS } from '../src/shared/types.js';
import { explainFailure } from '../src/core/errors.js';

const STYLE = '<style>.card { color: red; }</style>';

describe('html', () => {
  it('drops the note type style block instead of printing it', () => {
    const text = htmlToText(`${STYLE}Hello`);
    assert.equal(text, 'Hello');
    assert.ok(!text.includes('color'));
  });

  it('drops script blocks whole', () => {
    assert.equal(htmlToText('<script>alert(1)</script>Body'), 'Body');
  });

  it('keeps only the answer half when the template repeats the question', () => {
    const answer = answerBodyOnly('Question<hr id=answer>Answer');
    assert.equal(htmlToText(answer), 'Answer');
  });

  it('leaves the answer alone when there is no separator', () => {
    assert.equal(answerBodyOnly('Just the answer'), 'Just the answer');
  });

  it('turns block tags into line breaks', () => {
    assert.equal(htmlToText('one<br>two<div>three</div>'), 'one\ntwo\nthree');
  });

  it('does not put a blank line between fields that sit in their own blocks', () => {
    // The shape of a note type that wraps each field, including template
    // indentation between the tags.
    const html = `<div class="wrap">
  <div class="chips"><span>preposition</span></div>
  <div class="headword">aus</div>
  <ul><li>Which case does it take?</li>
    <li>Meaning?</li></ul>
</div>`;
    assert.equal(htmlToText(html), 'preposition\naus\nWhich case does it take?\nMeaning?');
  });

  it('keeps a blank line someone asked for with two line breaks', () => {
    assert.equal(htmlToText('one<br><br>two'), 'one\n\ntwo');
    assert.equal(htmlToText('<div>one<br><br></div><div>two</div>'), 'one\n\ntwo');
  });

  it('fits a four line question on one screen', () => {
    const html = '<div>preposition</div><div>aus</div><ul><li>Which case?</li><li>Meaning?</li></ul>';
    assert.equal(layoutPages(htmlToText(html), DEFAULT_LAYOUT).length, 1);
  });

  it('decodes entities including numeric ones', () => {
    assert.equal(decodeEntities('a&amp;b&#38;c&#x26;d'), 'a&b&c&d');
    assert.equal(decodeEntities('&nbsp;x'), ' x');
  });

  it('removes sound references from the visible text', () => {
    assert.equal(htmlToText('Say this [sound:a.mp3]'), 'Say this');
  });

  it('strips bidi isolates that the glasses font cannot render', () => {
    assert.equal(stripInvisibleCharacters('⁨ 4 ⁩d'), ' 4 d');
  });

  it('detects each unsupported content kind', () => {
    assert.equal(detectMedia('<img src=a.png>').hasImage, true);
    assert.equal(detectMedia('[sound:a.mp3]').hasAudioOrVideo, true);
    assert.equal(detectMedia('<video src=a></video>').hasAudioOrVideo, true);
    assert.equal(detectMedia('\\(x\\)').hasMath, true);
    assert.equal(detectMedia('[latex]x[/latex]').hasMath, true);
    assert.equal(detectMedia('<anki-mathjax>x</anki-mathjax>').hasMath, true);
    assert.equal(detectMedia('<table><tr></tr></table>').hasTable, true);
    assert.equal(detectMedia('<svg></svg>').hasRichMarkup, true);
  });

  it('does not treat a background image in the note type css as card media', () => {
    const html = '<style>.card { background-image: url(bg.png); }</style>Plain question';
    assert.equal(detectMedia(html).hasImage, false);
  });
});

describe('layout', () => {
  it('wraps on word boundaries', () => {
    assert.deepEqual(wrapText('the quick brown fox', 10), ['the quick', 'brown fox']);
  });

  it('splits a word longer than the line', () => {
    assert.deepEqual(wrapText('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  });

  it('keeps deliberate line breaks', () => {
    assert.deepEqual(wrapText('one\ntwo', 20), ['one', 'two']);
  });

  it('drops leading and trailing blank lines', () => {
    assert.deepEqual(wrapText('\n\nvalue\n\n', 20), ['value']);
  });

  it('paginates by line count', () => {
    const pages = paginate(['a', 'b', 'c', 'd', 'e'], 2);
    assert.deepEqual(pages, ['a\nb', 'c\nd', 'e']);
  });

  it('never emits a page over the firmware byte cap', () => {
    const long = 'あ'.repeat(400);
    const pages = layoutPages(long, { charsPerLine: 42, linesPerScreen: 6, maxPages: 1 });
    for (const page of pages) assert.ok(utf8Bytes(page) <= MAX_TEXT_BYTES, 'page exceeded cap');
  });

  it('truncates on a code point boundary', () => {
    const value = truncateToBytes('あああ', 7);
    assert.equal(value, 'ああ');
    assert.ok(utf8Bytes(value) <= 7);
  });

  it('returns one empty page for empty input', () => {
    assert.deepEqual(layoutPages('', { charsPerLine: 10, linesPerScreen: 2, maxPages: 1 }), ['']);
  });
});

describe('deck matching', () => {
  it('matches a deck and its subdecks but not a similar name', () => {
    assert.equal(deckMatches('Japanese', 'Japanese'), true);
    assert.equal(deckMatches('Japanese', 'Japanese::Verbs'), true);
    assert.equal(deckMatches('Japanese', 'Japanese Extra'), false);
  });

  it('is case insensitive', () => {
    assert.equal(deckMatches('japanese', 'Japanese::Verbs'), true);
  });

  it('excludes take priority over includes', () => {
    const filter = { ...DEFAULT_FILTER, includeDecks: ['A'], excludeDecks: ['A::B'] };
    assert.equal(deckAllowed('A', filter), true);
    assert.equal(deckAllowed('A::B', filter), false);
    assert.equal(deckAllowed('C', filter), false);
  });
});

describe('suitability', () => {
  const base = { deck: 'Demo', tags: [], noteType: 'Basic' };

  it('accepts a short text card', () => {
    const result = prepareCard(
      { ...base, questionHtml: `${STYLE}Capital of France?`, answerHtml: `${STYLE}<hr id=answer>Paris` },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.questionPages, ['Capital of France?']);
    assert.deepEqual(result.answerPages, ['Paris']);
  });

  it('skips a card with an image and says why', () => {
    const result = prepareCard(
      { ...base, questionHtml: 'Name this <img src=a.png>', answerHtml: '<hr id=answer>Femur' },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('image'));
  });

  it('skips audio, math, tables and long text', () => {
    const cases: Array<[string, string]> = [
      ['media', 'Listen [sound:a.mp3]'],
      ['math', 'Solve \\(x\\)'],
      ['table', '<table><tr><td>x</td></tr></table>'],
      ['too-long', 'word '.repeat(400)],
    ];
    for (const [reason, question] of cases) {
      const result = prepareCard(
        { ...base, questionHtml: question, answerHtml: '<hr id=answer>ok' },
        DEFAULT_FILTER,
      );
      assert.equal(result.ok, false, `${reason} should not pass`);
      assert.ok(result.reasons.includes(reason as never), `expected ${reason}, got ${result.reasons.join()}`);
    }
  });

  it('skips a card whose answer is empty after stripping media', () => {
    const result = prepareCard(
      { ...base, questionHtml: 'Question', answerHtml: '<hr id=answer><img src=a.png>' },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('empty'));
  });

  it('honours the excluded tag', () => {
    const result = prepareCard(
      { ...base, tags: ['NoGlasses'], questionHtml: 'Q', answerHtml: '<hr id=answer>A' },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('tag-excluded'));
  });

  it('allows a longer card when the page budget is raised', () => {
    const long = 'word '.repeat(60);
    const strict = prepareCard(
      { ...base, questionHtml: long, answerHtml: '<hr id=answer>ok' },
      DEFAULT_FILTER,
    );
    const relaxed = prepareCard(
      { ...base, questionHtml: long, answerHtml: '<hr id=answer>ok' },
      { ...DEFAULT_FILTER, layout: { ...DEFAULT_FILTER.layout, maxPages: 4 } },
    );
    assert.equal(strict.ok, false);
    assert.equal(relaxed.ok, true);
    assert.ok(relaxed.questionPages.length > 1);
  });
});

describe('gesture mapping', () => {
  it('maps the SDK event ordinals', () => {
    assert.equal(gestureFromOsEvent(0), 'click');
    assert.equal(gestureFromOsEvent(1), 'up');
    assert.equal(gestureFromOsEvent(2), 'down');
    assert.equal(gestureFromOsEvent(3), 'double_click');
    assert.equal(gestureFromOsEvent(9), 'long_press');
    assert.equal(gestureFromOsEvent(8), null);
    assert.equal(gestureFromOsEvent(undefined), null);
  });

  it('names the event source without filtering on it', () => {
    assert.equal(sourceFromEventSource(2), 'ring');
    assert.equal(sourceFromEventSource(1), 'glasses_right');
    assert.equal(sourceFromEventSource(3), 'glasses_left');
    assert.equal(sourceFromEventSource(undefined), 'unknown');
  });
});

describe('interaction reducer', () => {
  const question = { screen: 'question' as const, page: 0, pageCount: 1 };
  const answer = { screen: 'answer' as const, page: 0, pageCount: 1 };

  it('reveals the answer from the question', () => {
    assert.deepEqual(reduce(question, 'click'), { kind: 'reveal' });
    assert.deepEqual(reduce(question, 'down'), { kind: 'reveal' });
  });

  it('does nothing on a double tap on the question screen', () => {
    // Undo is deliberately not offered: AnkiConnect undo reverses the last
    // operation in the whole collection, which may be a desktop edit.
    assert.deepEqual(reduce(question, 'double_click'), { kind: 'none' });
  });

  it('grades from the answer screen', () => {
    assert.deepEqual(reduce(answer, 'click'), { kind: 'grade', ease: DEFAULT_GRADES.click });
    assert.deepEqual(reduce(answer, 'up'), { kind: 'grade', ease: DEFAULT_GRADES.up });
    assert.deepEqual(reduce(answer, 'down'), { kind: 'grade', ease: DEFAULT_GRADES.down });
    assert.deepEqual(reduce(answer, 'double_click'), {
      kind: 'grade',
      ease: DEFAULT_GRADES.double_click,
    });
  });

  it('quits on a long press from anywhere', () => {
    assert.deepEqual(reduce(question, 'long_press'), { kind: 'quit' });
    assert.deepEqual(reduce(answer, 'long_press'), { kind: 'quit' });
  });

  it('pages before it grades, so reaching the last page cannot grade', () => {
    const first = { screen: 'answer' as const, page: 0, pageCount: 3 };
    assert.deepEqual(reduce(first, 'down'), { kind: 'page', page: 1 });
    const middle = { screen: 'answer' as const, page: 1, pageCount: 3 };
    assert.deepEqual(reduce(middle, 'up'), { kind: 'page', page: 0 });
    const last = { screen: 'answer' as const, page: 2, pageCount: 3 };
    assert.deepEqual(reduce(last, 'down'), { kind: 'grade', ease: DEFAULT_GRADES.down });
    assert.deepEqual(reduce(last, 'up'), { kind: 'grade', ease: DEFAULT_GRADES.up });
  });

  it('ignores input while loading', () => {
    assert.deepEqual(reduce({ screen: 'loading', page: 0, pageCount: 1 }, 'click'), { kind: 'none' });
  });

  it('refreshes from the done screen', () => {
    assert.deepEqual(reduce({ screen: 'done', page: 0, pageCount: 1 }, 'click'), { kind: 'refresh' });
  });
});

describe('host event decoding', () => {
  it('treats a touch event with no eventType as a tap', () => {
    // Protobuf omits zero valued fields and CLICK_EVENT is zero, so this is
    // the exact payload a real tap produces.
    const decoded = gestureFromEvenHubEvent({ sysEvent: { eventSource: 1 } });
    assert.equal(decoded.gesture, 'click');
    assert.equal(decoded.source, 'glasses_right');
  });

  it('reads the explicit ordinals for the other gestures', () => {
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventType: 1 } }).gesture, 'up');
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventType: 2 } }).gesture, 'down');
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventType: 3 } }).gesture, 'double_click');
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventType: 9 } }).gesture, 'long_press');
  });

  it('reports a ring tap as coming from the ring', () => {
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventSource: 2 } }).source, 'ring');
  });

  it('ignores events that carry no touch payload', () => {
    assert.equal(gestureFromEvenHubEvent({}).gesture, null);
  });

  it('ignores an IMU report rather than reading it as a gesture', () => {
    assert.equal(gestureFromEvenHubEvent({ sysEvent: { eventType: 8 } }).gesture, null);
  });

  it('accepts a tap delivered as a text container event', () => {
    assert.equal(gestureFromEvenHubEvent({ textEvent: { containerID: 2 } as never }).gesture, 'click');
  });
});

describe('css background images', () => {
  const base = { deck: 'Demo', tags: [], noteType: 'Basic' };

  it('treats a background image in the card body as a picture', () => {
    const question =
      '<div style="background-image:url(flag.png);width:100px;height:60px"></div>Which country?';
    const result = prepareCard(
      { ...base, questionHtml: question, answerHtml: '<hr id=answer>France' },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, false, 'a card whose prompt is a css background must not be shown');
    assert.ok(result.reasons.includes('image'));
  });

  it('reports a note type background separately from card content', () => {
    const html = '<style>.card { background-image: url(paper.png); }</style>Plain question';
    const media = detectMedia(html);
    assert.equal(media.hasImage, false);
    assert.equal(media.hasNoteTypeBackgroundImage, true);
  });

  it('keeps a card whose note type merely has a decorative background', () => {
    const result = prepareCard(
      {
        ...base,
        questionHtml: '<style>.card { background-image: url(paper.png); }</style>Capital of Peru?',
        answerHtml: '<hr id=answer>Lima',
      },
      DEFAULT_FILTER,
    );
    assert.equal(result.ok, true);
  });

  it('can be told to skip note type backgrounds too', () => {
    const result = prepareCard(
      {
        ...base,
        questionHtml: '<style>.card { background-image: url(paper.png); }</style>Capital of Peru?',
        answerHtml: '<hr id=answer>Lima',
      },
      { ...DEFAULT_FILTER, skipNoteTypeBackgrounds: true },
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('image'));
  });
});

describe('grade legend', () => {
  it('describes the default mapping', () => {
    assert.equal(gradeLegend(DEFAULT_GRADES, EASE_LABELS), 'tap Good   up Easy   down Again   2tap Hard');
  });

  it('follows a changed mapping instead of assuming the default', () => {
    const swapped = { click: 1, up: 3, down: 4, double_click: 2 } as const;
    assert.equal(gradeLegend(swapped, EASE_LABELS), 'tap Again   up Good   down Easy   2tap Hard');
  });
});

describe('characters the glasses font cannot draw', () => {
  const ch = (code: number) => String.fromCodePoint(code);

  it('keeps the meaning of an approximate value', () => {
    // U+223C is the tilde operator, which the glasses drop silently.
    const input = `${ch(0x223c)}0.10${ch(0x2013)}0.15 between continents`;
    assert.equal(htmlToText(input), '~0.10-0.15 between continents');
  });

  it('replaces smart quotes, dashes and ellipsis with ascii', () => {
    const input = `${ch(0x201c)}it${ch(0x2019)}s fine${ch(0x201d)}${ch(0x2026)}`;
    assert.equal(htmlToText(input), '"it\'s fine"...');
  });

  it('spells out comparison and unit symbols', () => {
    assert.equal(htmlToText(`${ch(0x2264)}5`), '<=5');
    assert.equal(htmlToText(`${ch(0x2265)}5`), '>=5');
    assert.equal(htmlToText(`${ch(0x2260)}5`), '!=5');
    assert.equal(htmlToText(`3${ch(0x00b1)}1`), '3+/-1');
    assert.equal(htmlToText(`90${ch(0x00b0)}`), '90 deg');
    assert.equal(htmlToText(`a${ch(0x2192)}b`), 'a->b');
  });

  it('leaves japanese text alone, because the font draws it', () => {
    const kana = `${ch(0x3053)}${ch(0x3093)}${ch(0x306b)}${ch(0x3061)}${ch(0x306f)}`;
    assert.equal(htmlToText(kana), kana);
  });

  it('turns exotic spaces into ordinary ones', () => {
    assert.equal(htmlToText(`a${ch(0x00a0)}b`), 'a b');
  });
});

describe('failure messages for the display', () => {
  it('tells the wearer what to do when Anki is not answering', () => {
    const error = Object.assign(new Error('/api/session/start returned 502 {"error":"..."}'), {
      code: 'anki-unreachable',
    });
    assert.equal(explainFailure(error), 'Anki is not answering.\nOpen Anki on the desktop.');
  });

  it('names a missing key', () => {
    const error = Object.assign(new Error('401'), { code: 'bad-key' });
    assert.match(explainFailure(error), /missing its key/);
  });

  it('reports a dead connection rather than a stack trace', () => {
    assert.equal(explainFailure(new TypeError('fetch failed')), 'No connection to the card server.');
  });

  it('keeps an unknown message short enough for the display', () => {
    const long = new Error('x'.repeat(400));
    const shown = explainFailure(long);
    assert.ok(shown.length <= 92, `message was ${shown.length} characters`);
  });
});

describe('raised and lowered type', () => {
  it('does not turn an exponent into a different number', () => {
    // Stripping the tags would send 23 to the glasses and ask the wearer to
    // grade their answer to a question they were never shown.
    assert.equal(htmlToText('What is 2<sup>3</sup>?'), 'What is 2^(3)?');
  });

  it('keeps a subscript attached to its symbol', () => {
    assert.equal(htmlToText('H<sub>2</sub>O'), 'H_(2)O');
  });

  it('keeps a charge readable', () => {
    assert.equal(htmlToText('Na<sup>+</sup>'), 'Na^(+)');
  });
});

describe('double tap on a paged answer', () => {
  it('is inert until the last page, so two quick taps cannot grade unseen text', () => {
    const first = { screen: 'answer' as const, page: 0, pageCount: 3 };
    assert.deepEqual(reduce(first, 'double_click'), { kind: 'none' });
    const last = { screen: 'answer' as const, page: 2, pageCount: 3 };
    assert.deepEqual(reduce(last, 'double_click'), {
      kind: 'grade',
      ease: DEFAULT_GRADES.double_click,
    });
  });
});
