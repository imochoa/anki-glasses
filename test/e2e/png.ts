/**
 * Just enough PNG decoding to assert on what the glasses actually drew.
 *
 * The simulator returns 8 bit RGBA, non interlaced, which is the only shape
 * this handles. Anything else throws rather than guessing.
 */

import { inflateSync } from 'node:zlib';

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row major. */
  data: Buffer;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes: Buffer): Bitmap {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a png');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body.readUInt8(8);
      colorType = body.readUInt8(9);
      if (body.readUInt8(12) !== 0) throw new Error('interlaced png is not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8 bit rgba, got depth ${bitDepth} colour type ${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = 4;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  let pos = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;

    const target = out.subarray(row * stride, (row + 1) * stride);
    const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? target[i - channels] : 0;
      const up = previous ? previous[i] : 0;
      const upLeft = previous && i >= channels ? previous[i - channels] : 0;
      const value = line[i];

      switch (filter) {
        case 0:
          target[i] = value;
          break;
        case 1:
          target[i] = (value + left) & 0xff;
          break;
        case 2:
          target[i] = (value + up) & 0xff;
          break;
        case 3:
          target[i] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          target[i] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unknown png filter ${filter}`);
      }
    }
  }

  return { width, height, data: out };
}

/**
 * How lit a pixel is.
 *
 * The simulator's framebuffer holds a constant green in the colour channels and
 * carries the whole picture in alpha, so a comparison that looks only at rgb
 * sees every frame as identical. Coverage is therefore alpha weighted by
 * brightness.
 */
function coverage(data: Buffer, i: number): number {
  const alpha = data[i + 3] / 255;
  const brightness = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
  return alpha * brightness;
}

/** Pixels in a region carrying drawn content, as a fraction of the region. */
export function inkRatio(bitmap: Bitmap, region: Region): number {
  let lit = 0;
  let total = 0;
  for (let y = region.y; y < Math.min(region.y + region.height, bitmap.height); y += 1) {
    for (let x = region.x; x < Math.min(region.x + region.width, bitmap.width); x += 1) {
      const i = (y * bitmap.width + x) * 4;
      total += 1;
      if (coverage(bitmap.data, i) > 0.15) lit += 1;
    }
  }
  return total === 0 ? 0 : lit / total;
}

/** Fraction of pixels that differ between two bitmaps within a region. */
export function differenceRatio(a: Bitmap, b: Bitmap, region: Region): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  let total = 0;
  for (let y = region.y; y < Math.min(region.y + region.height, a.height); y += 1) {
    for (let x = region.x; x < Math.min(region.x + region.width, a.width); x += 1) {
      const i = (y * a.width + x) * 4;
      total += 1;
      if (Math.abs(coverage(a.data, i) - coverage(b.data, i)) > 0.1) differing += 1;
    }
  }
  return total === 0 ? 0 : differing / total;
}
