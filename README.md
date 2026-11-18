# Anki on the Even Realities G2, graded with the R1 ring

Review Anki cards on the glasses. No voice. Tap the ring to see the answer,
then one gesture records the grade and the next card appears.

Cards that cannot be read on a 576x288 monochrome display, anything with a
picture, audio, a table, math, or a wall of text, are held back. A held back
card is never graded and never buried. It stays due and waits for a normal
desktop review.

## How the pieces fit

The G2 runs web apps. Your code is served from a machine you control, the Even
App on the phone loads it in a WebView, and the SDK relays the display and the
input over Bluetooth. Nothing pairs to a PC.

```
Anki desktop (AnkiConnect on 127.0.0.1:8765)
      |  http, same machine
anki-glasses server  ------------------------- phone, Even App WebView
      |  serves the web app over your network              |  BLE
                                              G2 glasses + R1 ring
```

Two consequences worth knowing before you start:

- The server has to run on the machine Anki runs on, because AnkiConnect only
  listens on loopback.
- The phone has to be able to reach that machine, so use the LAN address or a
  Tailscale address, not localhost.

## Gestures

The ring and the temple pad send the same events, so either works.

| Screen   | tap             | swipe up  | swipe down  | double tap | hold |
| -------- | --------------- | --------- | ----------- | ---------- | ---- |
| Question | show the answer | page back | show answer | nothing    | quit |
| Answer   | Good            | Easy      | Again       | Hard       | quit |
| Done     | check again     |           |             | check again| quit |

When a card is allowed to run to more than one page, the paging gestures win
until the last page, so the gesture that carries you onto the last page can
never also grade the card. A double tap is inert until the last page as well,
because two quick taps meant to turn a page can arrive as one double tap.

There is deliberately no undo. AnkiConnect's undo reverses the last operation in
the whole collection, so a double tap here could just as easily reverse an edit
you made on the desktop a minute ago. Misgrades get fixed in Anki on the
desktop, where undo knows what it is undoing.

## Install and run

On the machine running Anki, with Anki open and the AnkiConnect add-on
installed:

```bash
npm install
npm run build
npm start
```

It prints the address to open, including a key:

```
Open this on the phone, the key is required:
  http://127.0.0.1:8710/?k=nq7Yb2...
```

Everything that reads or writes the collection requires that key, because the
server has to listen on a real network interface for the phone to reach it. It
changes on every restart unless you pin it:

```bash
ANKI_GLASSES_KEY='something long and random' npm start
```

Keep it in the environment rather than in the config file.

### In a container

The `Dockerfile` builds the server and the app into one image. The image
holds only the build output, since the server has no runtime dependencies.
Anki and AnkiConnect stay on the host:

```bash
docker build -t anki-glasses .
docker run --rm -p 8710:8710 \
  -e ANKI_GLASSES_KEY='something long and random' \
  -e ANKI_CONNECT_URL=http://host.docker.internal:8765 \
  anki-glasses
```

`host.docker.internal` reaches the host's loopback with Docker Desktop. With
podman, use `host.containers.internal`. On Linux with Docker Engine,
AnkiConnect's loopback is not reachable from the default bridge network, so
run with `--network host` and leave `ANKI_CONNECT_URL` at its default.

To use a config file, mount it and the server finds it at
`/config/anki-glasses.config.json`:

```bash
-v "$PWD/anki-glasses.config.json:/config/anki-glasses.config.json:ro"
```

## Getting it onto the glasses

Install the Even App on the phone, pair the G2 and the R1 there as normal, then
either point the Even App at the running server or sideload with a QR code:

```bash
npx evenhub qr --url "http://MACHINE_ADDRESS:8710/?k=YOUR_KEY"
```

Use the machine's LAN or Tailscale address. `localhost` will not work, because
the phone has to reach it.

`app.json` holds the app manifest. The `permissions.network.whitelist` entry
has to name the address the phone will use before the packaged form will be
allowed to call it. It ships with a placeholder address, so put your own there
first. To build a distributable package:

```bash
npm run pack
```

## The day the ring arrives

Nothing here needs the glasses or the ring to be near this machine, and nothing
pairs to a PC. In order:

1. Charge the R1 and pair it in the Even App, alongside the G2. The Even App is
   the only thing either device pairs to.
2. On the machine running Anki, open Anki, then start this server with
   a pinned key and note the machine's LAN or Tailscale address.
3. Put `permissions.network.whitelist` in `app.json` on that address, then
   `npm run pack` and `npm run qr` with the same address and key.
4. Load it in the Even App and put the glasses on. The first card should appear
   within a second or two.
5. Tap once. If the answer appears, the ring is talking to the app. Swipe up to
   grade it Easy and check the interval Anki reports on the display matches what
   the desktop shows for that card.

If a gesture does nothing, the app logs every event it receives. `eventSource`
in those logs says whether the input came from the ring or a temple pad, so it
tells you which device is being heard.

## Check the filter before reviewing anything

This is read only. It renders every due card and counts what would be shown:

```bash
npm run report -- --limit 400000
```

It finishes by naming decks where almost nothing can be shown. A deck is left
alone when a subdeck under it is worth keeping, because an exclusion covers
everything below it. To turn the rest into deck level exclusions so they are
skipped outright:

```bash
npm run report -- --limit 400000 --write-config --threshold 20
```

Prove the write path on a scratch deck that the script creates and deletes:

```bash
npx tsx tools/live-check.ts
```

## Configuration

`anki-glasses.config.json` sits next to the project and is not tracked by
git, because it names the decks in one person's collection. Copy
`anki-glasses.config.example.json` to that name to start. Every field is
optional and the defaults are what the tables above describe.

`includeDecks` is a whitelist when it is not empty. `excludeDecks` always wins.
Both match a deck and everything under it, so `Astronomy` also excludes
`Astronomy::Module 1 - Vocabulary`.

The report command above names the decks under the threshold, 20 percent
usable by default, and `--write-config` records them as exclusions. Rerun it
after the collection changes.

Raising `layout.maxPages` lets longer cards through, paged. Raising
`charsPerLine` past about 46 risks text wrapping past the bottom of the
container, where the firmware simply does not draw it.

`skipNoteTypeBackgrounds` is off by default. A background image declared in a
note type's style block decorates every card of that type rather than belonging
to any one card, and in the author's collection turning it on hid 31 otherwise
readable cards. A background image in the card body always counts as a picture.

## Why those layout numbers

Measured on the official simulator at 576x288 with a digit ruler: a full width
line held 49 to 50 digits, and the screen held about 10 rows at roughly 28px.
The G2 font is proportional, so the defaults sit under the measurement. The body
region is 206px, which is 7 rows, and 6 is used so a run of wide glyphs cannot
push content off the bottom.

## Scheduling

Grades go to Anki through `answerCards`, so Anki's own scheduler picks the
interval. This app never writes an interval itself, and the interval it shows
after a grade is the one Anki reported for that button.

Cards are taken from `is:due`, in three passes per deck tree: learning cards
first, then anything at least a day overdue, then the rest. Per deck daily
limits are honoured by asking Anki for its own counts for every selected deck,
so a subdeck's own limit holds even while its parent still has allowance. The
allowance is spent when a card is actually shown, not on cards the filter then
holds back.
Learning and review allowances are tracked apart, so a learning card the filter
holds back cannot turn into permission to serve an extra review. Once every
selected deck has spent both, the session ends rather than reading through the
rest of the due list. Two cards of the same note are not both shown in one
session.

Anki stays open on the desktop while you review on the glasses, so the due list
goes stale underneath. In the moment a card is chosen to be shown, and again
before its grade is sent, the session asks Anki whether that card is still due.
The question is asked about that one card at that moment, not about the batch
it arrived in, so a card that goes stale while it waits its turn in the queue
cannot take the allowance slot a card that is still due could have used. A card you reviewed,
buried or suspended on the desktop in the meantime is dropped instead of graded,
and the glasses say `Already answered elsewhere` rather than pretending the
grade landed.

Starting the app again while a session is running resumes that session instead
of replacing it, so reloading the WebView, or opening the same address on a
second phone, cannot orphan the card you are looking at, or the one being
chosen for you. If Anki stops answering while a card is being chosen, nothing
is consumed: the retry asks for the same cards again.

Each served card carries a single use token, so a gesture that arrives twice
cannot grade the same card twice. If the call to Anki fails outright, the
session asks Anki whether the review count for that card went up before
deciding whether the grade landed, so an ambiguous timeout neither strands the
card nor grades it twice. If Anki cannot answer that question either, the card
stays unsettled rather than being called ungraded: the wearer retries, and the
retry settles the first attempt before sending anything. Guessing there would
grade a learning card twice, because it comes round again a minute later.

## Tests

```bash
npm test          # unit and integration, no hardware, no Anki
npm run test:e2e  # drives the real app in the official simulator
```

The end to end run boots a mock Anki, boots the real server, loads the real app
in the Even Hub simulator, and drives it through the simulator's input API,
which is the same event path the ring uses. It asserts on the grades that
reached Anki and on the rendered framebuffer: the body region is decoded from
the simulator's screenshot and compared against committed baseline images, so a
wrong card on the display fails the run. Refresh the baselines deliberately with
`E2E_UPDATE_BASELINE=1` when the fixture or the simulator changes.

On a headless machine, start a display first:

```bash
Xvfb :77 -screen 0 1280x900x24 &
DISPLAY=:77 npm run test:e2e
```

Nothing here has run on real G2 hardware or a real R1 ring. The simulator is the
official one and drives the same SDK and the same event path, but it is not the
firmware.

## Notes from the hardware protocol

- A tap arrives as `{"sysEvent":{"eventSource":1}}` with no `eventType` field at
  all. The wire format is protobuf derived and omits fields holding their
  default value, and `CLICK_EVENT` is ordinal zero. Anything that requires an
  explicit `eventType` loses every tap.
- `eventSource` says whether the input came from the ring or a temple pad, but
  the simulator always reports the right temple. It is recorded and never
  filtered on, so the app works with either input.
- A text container payload must stay under 1000 bytes. Pages are built to
  respect that even for scripts that cost three bytes a character.
- Anki's interval labels arrive wrapped in Unicode bidi isolates, which the
  glasses font cannot render. They are stripped before display.
- There is one type size, so `2<sup>3</sup>` would arrive as `23`, a different
  question. Raised and lowered type is spelled out as `2^(3)` and `H_(2)O`
  before layout.
- The font silently drops characters it has no glyph for. A real card whose
  answer began with a tilde operator, meaning approximately, displayed as an
  exact range. Typographic and mathematical characters with a faithful ascii
  equivalent are substituted before layout. Kana and kanji are left alone,
  because the font draws them.
- The simulator's screenshot is green in all three colour channels and carries
  the entire picture in alpha. A pixel comparison that ignores alpha sees every
  frame as identical.

## Meta Neural Band

Short version: it cannot drive the G2 and nobody has made it work outside Meta's
own hardware. See `docs/neural-band.md`.
