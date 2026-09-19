# Can the Meta Neural Band drive the G2?

Short answer: no, and it is not close. Use the R1.

## What the band is

The Meta Neural Band is the sEMG wristband that ships with Meta Ray-Ban
Display. It reads muscle signals at the wrist, classifies them into gestures on
the device itself, and sends gesture events over Bluetooth.

It is not a standard BLE HID device. It does not appear as a keyboard, mouse or
gamepad, it pairs only through the Meta AI app, and its GATT services are not
documented publicly. Pairing is bound to the Meta account and to the Ray-Ban
Display glasses.

## Has anyone made it work with other hardware

No published success. Searches across GitHub, Reddit, Hacker News, XDA and the
usual reverse engineering forums turn up no project that gets gesture events out
of the band on a non-Meta host, and no public write up of the pairing or the
protocol.

The closest public work is a commercial hardware teardown from TechInsights,
which identifies the silicon and the construction. That is a long way from
pairing with the band and reading gesture events off it.

The closest thing to an official answer is Meta's own developer forum, where a
request for Neural Band sensor data access was met with a statement that only
what exists today can be discussed. No roadmap was offered.

## What Meta does offer

Meta's own FAQ draws the line clearly. The Wearables Device Access Toolkit, the
one a phone app uses, exposes the cameras, microphones, speakers and, on Ray-Ban
Display, the display. It does not expose the band at all. Band gestures reach
only Web Apps running on Ray-Ban Display, and there the vocabulary is fixed:
swipe left, right, up and down, index finger pinch for enter, middle finger
pinch for cancel. No custom gestures, no raw sEMG, and no path to another
vendor's glasses.

That fixed vocabulary is, annoyingly, almost exactly what this app needs. It is
still unreachable, because it exists only inside Meta's own web runtime on
Meta's own glasses.

Meta has also open sourced a large sEMG dataset and the models from its Nature
paper. That material is for people building their own sEMG hardware. It does not
help drive the retail band, because the retail band classifies gestures in
firmware and does not stream raw signal to arbitrary hosts.

## What it would take

Every one of these would have to be solved, in order:

1. Get the band to pair with something that is not the Meta AI app. Pairing
   looks account bound and key bound, so this likely means extracting keys from
   a device or an app binary.
2. Work out undocumented GATT services and the event framing.
3. Establish that the band emits usable gesture events to an unrecognised host,
   rather than only to a paired Meta device. If it emits raw sEMG instead, a
   gesture classifier would have to be trained from scratch.
4. Keep it working across firmware updates.

That is months of uncertain work for an input device that would still be less
reliable than the ring, and it is the sort of thing a firmware update breaks.

## What to use instead

The R1 ring is the supported path and this app already targets it: tap, double
tap, swipe up, swipe down and long press all arrive through the same Even Hub
event stream, with a source field saying whether the input came from the ring or
from a temple pad.

If a wrist device is ever wanted instead, Mudra Link is an sEMG band that
deliberately works across platforms over BLE, which is the property the Meta band
lacks.

## Sources

Checked on 2026-09-10.

- Meta's wearables developer FAQ, on what the toolkit exposes and where band
  gestures are available:
  https://developers.meta.com/wearables/faq/
- The toolkit announcement, on the camera, microphone and speaker access it
  actually ships:
  https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/
- Meta's sEMG research programme and the open sourced datasets:
  https://www.meta.com/emerging-tech/emg-wearable-technology/
  https://ai.meta.com/blog/open-sourcing-surface-electromyography-datasets-neurips-2024/
- The Nature paper and its code and models, for anyone building their own sEMG
  hardware rather than trying to drive the retail band:
  https://www.nature.com/articles/s41586-025-09255-w
  https://github.com/facebookresearch/generic-neuromotor-interface
- The one piece of public hardware work on the band, a paid teardown, not a
  protocol break:
  https://www.techinsights.com/blog/summary-meta-ray-ban-display-neural-band-deep-dive-teardown
- Mudra, an sEMG band that does publish a cross platform BLE developer kit:
  https://mudra-band.com/

No source found in any of these searches describes gesture events being read
from a Meta Neural Band by anything other than Meta's own paired hardware.
